import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  __internal, approveEnrollment, beginEnrollment, fingerprintOf, openSealed,
  releaseToHost, type EnrollmentApproval,
} from "./enroll.js";

const { seal } = __internal;
const now = () => Math.floor(Date.now() / 1000);

test("a sealed secret round-trips to the host it was sealed for", () => {
  const host = beginEnrollment("vps-1");
  const sealed = seal(host.request.publicKey, "sk-live-abc123", now() + 600);
  assert.equal(openSealed(host, sealed), "sk-live-abc123");
});

test("a different host cannot open a sealed secret", () => {
  const a = beginEnrollment("vps-1");
  const b = beginEnrollment("vps-2");
  const sealed = seal(a.request.publicKey, "sk-live-abc123", now() + 600);

  assert.throws(() => openSealed(b, sealed), /WRONG_RECIPIENT/);

  // Even with the fingerprint check defeated, the X25519 agreement still fails.
  assert.throws(
    () => openSealed(b, { ...sealed, forFingerprint: b.request.fingerprint }),
    /unable to authenticate|bad decrypt|Unsupported state/i,
  );
});

test("an expired secret is refused", () => {
  const host = beginEnrollment("vps-1");
  const sealed = seal(host.request.publicKey, "sk-live-abc123", now() - 1);
  assert.throws(() => openSealed(host, sealed), /SECRET_EXPIRED/);
});

test("a request whose fingerprint does not match its key is rejected without the device", async () => {
  const host = beginEnrollment("vps-1");
  const tampered = { ...host.request, fingerprint: "0000-0000" };

  // No device is attached in CI, so reaching one would throw something else entirely.
  await assert.rejects(() => approveEnrollment(tampered), /FINGERPRINT_MISMATCH/);
});

test("an expired enrollment releases nothing, and never touches the ring", async () => {
  const host = beginEnrollment("vps-1");
  const approval: EnrollmentApproval = {
    request: host.request,
    approvedBy: "0x0000000000000000000000000000000000000000",
    signature: "0x00",
    expiresAt: now() - 1,
  };
  // wallet-cli is not installed here; ENROLLMENT_EXPIRED must come first regardless.
  await assert.rejects(
    () => releaseToHost(approval, "ciphertext", { key: "attenuate" }),
    /ENROLLMENT_EXPIRED/,
  );
});

test("the fingerprint is a stable function of the key", () => {
  const host = beginEnrollment("vps-1");
  assert.equal(fingerprintOf(host.request.publicKey), host.request.fingerprint);
  assert.match(host.request.fingerprint, /^[0-9a-f]{4}-[0-9a-f]{4}$/);
});
