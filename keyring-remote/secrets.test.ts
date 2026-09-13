import { strict as assert } from "node:assert";
import { test } from "node:test";
import { openCapability, releaseCapability } from "../broker/secrets.js";
import { ringStatus } from "../broker/keyring.js";

// The real CLI needs a provisioned ring, which needs hardware. The scoping and expiry
// logic does not, so it is exercised against a stand-in that only round-trips bytes.
process.env.WALLET_CLI = "/tmp/fake-ring.sh";
const ring = { key: "attenuate" };

test("a released capability round-trips with its scope intact", async () => {
  const cap = await releaseCapability(42n, 6, 300, ring);
  const opened = await openCapability(cap.token, ring);
  assert.equal(opened.node, 42n);
  assert.equal(opened.capBit, 6);
});

test("an expired capability is refused", async () => {
  const cap = await releaseCapability(42n, 6, -1, ring);
  await assert.rejects(() => openCapability(cap.token, ring), /CAPABILITY_EXPIRED/);
});

test("each release is distinct, so a token cannot be replayed as another", async () => {
  const a = await releaseCapability(42n, 6, 300, ring);
  const b = await releaseCapability(42n, 6, 300, ring);
  assert.notEqual(a.token, b.token);
});

test("ringStatus reports ready when the ring answers", async () => {
  const s = await ringStatus();
  assert.equal(s.state, "ready");
  assert.deepEqual(s.keys, ["attenuate"]);
});
