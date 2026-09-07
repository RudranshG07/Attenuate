import { randomBytes } from "node:crypto";
import { decrypt, encrypt, type RingOptions } from "./keyring.js";

export interface ScopedCapability {
  node: bigint;
  capBit: number;
  expiresAt: number;
  token: string;
}

interface Sealed {
  node: string;
  capBit: number;
  expiresAt: number;
  nonce: string;
}

export async function releaseCapability(
  node: bigint,
  capBit: number,
  ttlSeconds: number,
  ring: RingOptions,
): Promise<ScopedCapability> {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload: Sealed = {
    node: node.toString(),
    capBit,
    expiresAt,
    nonce: randomBytes(16).toString("hex"),
  };
  const token = await encrypt(JSON.stringify(payload), ring);
  return { node, capBit, expiresAt, token };
}

export async function openCapability(
  token: string,
  ring: RingOptions,
): Promise<ScopedCapability> {
  const raw = JSON.parse(await decrypt(token, ring)) as Sealed;
  if (raw.expiresAt < Math.floor(Date.now() / 1000)) {
    throw new Error("CAPABILITY_EXPIRED");
  }
  return {
    node: BigInt(raw.node),
    capBit: raw.capBit,
    expiresAt: raw.expiresAt,
    token,
  };
}
