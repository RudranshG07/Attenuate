# Ledger DX feedback

Written as we go, ETHOnline 2026. Project: Attenuate, an agent permission layer where the Key Ring is the root of trust.

## Environment

| | |
|---|---|
| `@ledgerhq/wallet-cli` | 2.1.0 |
| OS | macOS 15 (Darwin 25.6.0) |
| Node | v26.5.0 |
| Device | none attached at time of writing |

## What worked well

**Errors are actionable.** Running `ring keys` before initialising returns exactly the right thing:

```json
{ "ok": false, "error": { "kind": "command-execution",
  "message": "Ledger Key Ring not initialized. Run `wallet-cli ring init` first." } }
```

Named error kind, plain-English message, and the literal next command. Most CLIs give a stack trace here.

**Local install works, no global needed.** `npm i @ledgerhq/wallet-cli` and `./node_modules/.bin/wallet-cli` behaved identically to a global install. Useful for CI and for keeping a hackathon repo self-contained.

**`--output json` on every subcommand.** Machine-readable by default is the right call for an agent-facing CLI.

## Issues

### 1. The skill-install tip corrupts JSON output

**Ran**

```
wallet-cli ring keys --output json
```

**Expected** a parseable JSON document on stdout.

**Got** a human-readable banner emitted ahead of the JSON, on the same stream:

```
Tip: install the Ledger wallet-cli skill so Claude Code can drive this CLI:
  wallet-cli skill install --agent claude
{
  "ok": false,
  ...
}
```

`JSON.parse(stdout)` throws. Every consumer has to do this:

```ts
const i = stdout.indexOf("{");
JSON.parse(stdout.slice(i));
```

That is fragile, and it breaks outright if a future tip contains a brace.

**Suggestion** Send the tip to stderr, or suppress it when `--output json` is set. A flag like `--no-tips` or honouring `NO_COLOR`/`CI` would also work. This is the single change that would most improve the agent-integration experience, which is ironic given the tip is advertising agent integration.

### 2. `ring` has no typed-data signing, and nothing says so

**Expected** Since the track brief centres on agents and the Key Ring, we assumed `wallet-cli ring` would cover the signing our root-of-trust needed: one EIP-712 mandate signed on device.

**Got** `ring` is `init | encrypt | decrypt | keys | destroy` — LKRP secret encryption only. Transaction signing is `wallet-cli send`. EIP-712 typed-data signing is in a different package entirely, `@ledgerhq/device-signer-kit-ethereum`, via `signerEth.signTypedData(path, typedData)`.

That is a reasonable separation, but we lost time to it because:

- The Key Ring docs page does not mention that signing lives elsewhere.
- The Ethereum Signer Kit page does not mention the Key Ring.
- The ETHOnline track page names `wallet-cli ring` prominently without noting it does not sign.

**Suggestion** One cross-reference line on the Key Ring page: *"Key Ring encrypts secrets. To sign transactions use `wallet-cli send`; to sign EIP-712 typed data use the Ethereum Signer Kit."* Thirty seconds of docs, an hour saved per team.

### 3. `--output` is documented per-subcommand but the tip ignores it

Minor, but `ring encrypt --help` documents `--output human|json` as a normal option, which sets the expectation that JSON mode is clean. See issue 1.

### 4. DMK's ESM build breaks under Node's native ESM resolver

**Ran** `node script.mjs` importing `@ledgerhq/device-management-kit` 1.9.0 on Node 26.

**Got**

```
ERR_UNSUPPORTED_DIR_IMPORT: Directory import
'.../device-management-kit/lib/esm/src' is not supported
```

`lib/esm/index.js` does `export * from "./src"` with no extension and no `index.js`
resolution, which bundlers tolerate and Node does not.

**Workaround** run through `tsx` or any bundler.

**Suggestion** emit explicit `./src/index.js` in the ESM build. One-line fix, and it
is the difference between `node script.mjs` working and not.

### 5. Speculos works, but nothing says so

Four separate teams asked in the hackathon Discord over four days whether Speculos is
acceptable and whether the Key Ring works against it. No answer at time of writing.

It does work. For the record, the full recipe:

```bash
# the image bundles no apps; fetch the ELF from app-ethereum releases
curl -sLO https://github.com/LedgerHQ/app-ethereum/releases/download/1.22.3/app-1.22.3-nanox.elf

docker run -d -p 5001:5000 -v "$PWD":/apps ghcr.io/ledgerhq/speculos:latest \
  --model nanox --display headless --api-port 5000 /apps/app.elf
```

```ts
new DeviceManagementKitBuilder()
  .addTransport(speculosTransportFactory("http://localhost:5001", false, DeviceModelId.NANO_X))
  .build();
```

Confirmed working: discovery, connect, session, and `getAddress` returning a real
derived address with no hardware attached.

Two snags worth documenting:

- The Speculos image ships no app binaries, and nothing in the docs points at the
  `app-ethereum` releases page as the place to get one.
- Port 5000 is the Speculos default and is also macOS AirPlay Receiver, so the
  first `docker run` fails with a confusing bind error on every recent Mac.

**Suggestion** A short "developing without hardware" page covering exactly this
would unblock a meaningful number of hackathon teams. Right now the only way to
find it is to read the SDK dependency list and guess.

### 6. `signTypedData` fails with 6a80 until blind signing is enabled, and the error does not say so

**Ran** `signerEth.signTypedData(path, typedData)` on Speculos with `getAddress`
already succeeding on the same session.

**Got** `EthAppCommandError { errorCode: "6a80", message: "Invalid data" }`

We tried three payload shapes, including a minimal single-string message, and all
three failed identically, which ruled out our data.

**Cause** The device screen said it plainly: *"Blind signing must be enabled in
settings."* EIP-712 without clear-signing descriptors needs the app setting on.
Nothing in the SDK surfaces this; the API error is a bare 6a80.

**Fix** Enable it by driving the emulator's button API:

```bash
press right   # App settings
press both    # enter
press both    # toggle Blind signing
```

After that, signing succeeds and the signature recovers to the device address.

**Suggestion** Map 6a80 in the EIP-712 path to the device's own message. The
emulator already knows the answer; the SDK just does not pass it up. This is a
one-line error-mapping change that would save every team hitting it.

**Related** On an emulator with no CAL descriptors, blind signing is the only path,
so the device shows a hash rather than the mandate fields. For a project whose whole
point is that a human approves a legible mandate, that is a real gap. A documented
way to supply local clear-signing descriptors for a custom domain would matter to us
more than almost anything else in the stack.

## Open questions, now answered

**Headless enrolment on a host with no USB port.** This is the track's second ask and
the one we most wanted to build. `ring init` needs a device on the machine, so a VPS
can never be a trustchain member, and the `WALLET_PASS` pattern only covers a machine
that is already enrolled.

What we built instead of moving the ring: the ring stays on the operator's machine,
the remote host generates an ephemeral X25519 keypair, and the device signs an
EIP-712 approval over an 8-character fingerprint of that key which the operator reads
off the device screen. Secret releases are then decrypted from the ring on the
operator's machine and re-encrypted to the approved key. The plaintext is never on
the wire, the ring never leaves the desk, and the VPS holds a short-lived capability
rather than a key.

`keyring-remote/enroll.ts`. Tested for the three failures that matter: a different
host cannot open a sealed secret, an expired secret is refused, and a request whose
fingerprint does not match its own public key is rejected before the device is asked.

**Suggestion.** A documented enrolment story for hosts without a device is the single
biggest gap we hit. The primitives are all there; what is missing is a page saying
"here is how a CI runner or a VPS participates without becoming a member". We would
have built on it rather than designing it.

## Still open

**Speculos and the Key Ring together.** The DMK transport gives us signing on an
emulator, which covers the mandate and the escalation prompts. `wallet-cli ring`
itself still wants real hardware for `init`, so the encrypt/decrypt half of our
integration is written against the documented CLI contract but exercised only with a
device attached. Confirming whether the trustchain layer can be driven against
Speculos directly would close that gap.
