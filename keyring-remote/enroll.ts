import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes } from "node:crypto";
import { decrypt as ringDecrypt, type RingOptions } from "../broker/keyring.js";

/**
 * Ledger Key Ring on a host with no USB port.
 *
 * `wallet-cli ring init` needs a device on the machine, so a VPS can never be a
 * trustchain member. The answer is not to move the ring; it is to leave the ring on
 * the operator's machine and give the remote host scoped, short-lived secrets it can
 * open exactly once.
 *
 *   1. the VPS generates an ephemeral X25519 keypair and asks to enrol
 *   2. the operator's machine shows the request and the device signs an approval
 *      over the exact public key and host label
 *   3. for each release, the operator decrypts from the Key Ring and re-encrypts to
 *      the approved ephemeral key
 *   4. the VPS opens it locally; the plaintext never touches the wire and the ring
 *      never leaves the operator's machine
 *
 * The VPS holds a capability, not a key, which is the same property the on-chain
 * grants have.
 */

export interface EnrollmentRequest {
  hostLabel: string;
  publicKey: string;   // base64 X25519 SPKI
  nonce: string;
  requestedAt: number;
  fingerprint: string; // short hash an operator can read off the device screen
}

export interface EnrollmentApproval {
  request: EnrollmentRequest;
  approvedBy: string;
  signature: string;
  expiresAt: number;
}

export interface SealedSecret {
  forFingerprint: string;
  ephemeralPublicKey: string;
  iv: string;
  tag: string;
  ciphertext: string;
  expiresAt: number;
}

const b64 = (b: Buffer) => b.toString("base64");
const unb64 = (s: string) => Buffer.from(s, "base64");

function spki(key: ReturnType<typeof createPublicKey>) {
  return key.export({ type: "spki", format: "der" }) as Buffer;
}

/** Short, human-readable identity for the key, so the operator can compare it on the device. */
export function fingerprintOf(publicKeyB64: string): string {
  const h = createHash("sha256").update(unb64(publicKeyB64)).digest("hex");
  return h.slice(0, 8).match(/.{1,4}/g)!.join("-");
}

// ---- 1. on the VPS -------------------------------------------------------

export interface PendingEnrollment {
  request: EnrollmentRequest;
  /** Kept in memory on the remote host only. Never transmitted. */
  privateKeyPem: string;
}

export function beginEnrollment(hostLabel: string): PendingEnrollment {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const pub = b64(spki(publicKey));
  const request: EnrollmentRequest = {
    hostLabel,
    publicKey: pub,
    nonce: b64(randomBytes(16)),
    requestedAt: Math.floor(Date.now() / 1000),
    fingerprint: fingerprintOf(pub),
  };
  return {
    request,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  };
}

// ---- 2. on the operator's machine, with the device ----------------------

export const ENROLLMENT_TYPES = {
  Enrollment: [
    { name: "hostLabel", type: "string" },
    { name: "fingerprint", type: "string" },
    { name: "nonce", type: "string" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

/**
 * The device signs over the fingerprint the operator can read on its screen, so
 * approving the wrong host requires misreading eight characters rather than
 * trusting a channel.
 */
export async function approveEnrollment(
  request: EnrollmentRequest,
  ttlSeconds = 86_400,
): Promise<EnrollmentApproval> {
  // Checked before the device module is even loaded: a request that does not match
  // its own key is never worth waking the device for.
  if (fingerprintOf(request.publicKey) !== request.fingerprint) {
    throw new Error("FINGERPRINT_MISMATCH: the request does not match its own key");
  }

  const { getAddress, signTypedData } = await import("../broker/device.js");
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;

  const signature = await signTypedData({
    domain: { name: "Attenuate", version: "1", chainId: Number(process.env.ATTENUATE_CHAIN_ID ?? 31337) },
    types: ENROLLMENT_TYPES as never,
    primaryType: "Enrollment",
    message: {
      hostLabel: request.hostLabel,
      fingerprint: request.fingerprint,
      nonce: request.nonce,
      expiresAt: String(expiresAt),
    },
  });

  return { request, approvedBy: await getAddress(), signature, expiresAt };
}

// ---- 3. release a secret to an approved host ----------------------------

function seal(recipientSpkiB64: string, plaintext: string, expiresAt: number): SealedSecret {
  const recipient = createPublicKey({ key: unb64(recipientSpkiB64), format: "der", type: "spki" });
  const eph = generateKeyPairSync("x25519");

  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipient });
  const key = createHash("sha256").update(shared).digest();

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  return {
    forFingerprint: fingerprintOf(recipientSpkiB64),
    ephemeralPublicKey: b64(spki(eph.publicKey)),
    iv: b64(iv),
    tag: b64(cipher.getAuthTag()),
    ciphertext: b64(ct),
    expiresAt,
  };
}

/**
 * Runs on the operator's machine. Reads from the Key Ring, re-encrypts to the
 * approved host. The ring never moves and the plaintext is never on the wire.
 */
export async function releaseToHost(
  approval: EnrollmentApproval,
  ciphertextFromRing: string,
  ring: RingOptions,
  ttlSeconds = 600,
): Promise<SealedSecret> {
  const now = Math.floor(Date.now() / 1000);
  if (approval.expiresAt < now) throw new Error("ENROLLMENT_EXPIRED");

  const plaintext = await ringDecrypt(ciphertextFromRing, ring);
  return seal(approval.request.publicKey, plaintext, now + ttlSeconds);
}

// ---- 4. back on the VPS -------------------------------------------------

export function openSealed(pending: PendingEnrollment, sealed: SealedSecret): string {
  if (sealed.forFingerprint !== pending.request.fingerprint) {
    throw new Error("WRONG_RECIPIENT: sealed for a different host");
  }
  if (sealed.expiresAt < Math.floor(Date.now() / 1000)) {
    throw new Error("SECRET_EXPIRED");
  }

  const priv = createPrivateKey({ key: pending.privateKeyPem, format: "pem", type: "pkcs8" });
  const eph = createPublicKey({ key: unb64(sealed.ephemeralPublicKey), format: "der", type: "spki" });

  const shared = diffieHellman({ privateKey: priv, publicKey: eph });
  const key = createHash("sha256").update(shared).digest();

  const decipher = createDecipheriv("aes-256-gcm", key, unb64(sealed.iv));
  decipher.setAuthTag(unb64(sealed.tag));
  return Buffer.concat([decipher.update(unb64(sealed.ciphertext)), decipher.final()]).toString("utf8");
}

/** Exposed for tests and for the fallback path when no device is attached. */
export const __internal = { seal };
