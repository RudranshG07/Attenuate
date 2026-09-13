# Partner write-ups

One per partner: how we used the tools, what we fed back, and what we would say to
the team. Numbers are measured, not estimated.

---

# Ledger

## What we built on the Ledger stack

Attenuate is a permission layer for agents that spend money. The Ledger is not a
signer bolted on the side; it is the only reason the system can exist. `initRoot`
recovers an EIP-712 `RootMandate` signature and compares it to `deviceKey`. **There is
no owner function, no admin path and no seed method that bypasses it** — a test
asserts that a freshly deployed `GrantStore` has an empty root. Unplug the device and
nothing in the tree can be created.

Three device touchpoints. One and three run end to end on Speculos with no hardware;
the second needs a ring, and `wallet-cli ring init` says *device required*, which is
the limitation the next section is about.

**1. The root mandate.** One EIP-712 signature establishes the capability bitmask,
spend cap, query budget, expiry and delegation depth for the entire tree. Everything
below is a strict subset, enforced in the registry contract. `broker/mandate.ts`.

**2. Scoped secret release.** `wallet-cli ring encrypt/decrypt` seals a short-lived,
scope-bound token for a sub-agent, so the sub-agent receives a capability and never a
key — the track brief's own sentence. `broker/secrets.ts` is written against the CLI,
but we cannot show it running: a ring has to be created by `ring init`, which requires
a physical device we do not have. What we *can* show is the part that does not need
one, below.

**3. Escalation as a prompt, not a revert.** When a grant is refused for running out
of unallocated cap or budget, `grant_capability` raises an EIP-712 `Escalation` on the
device showing the name, the reason, what was needed and what the mandate permits. A
rejection is a decision the code understands: the device reports it as `0x6985
"Condition not satisfied"`, and `requestApproval` returns `false` rather than throwing.

Only quantitative refusals escalate. Asking for a capability the parent never held is
structural, and no signature widens it, because the registry would refuse the mint
either way.

## The second ask: Key Ring on a host with no USB port

This was the part we most wanted to build, and the part with the least prior art.

`ring init` requires a device on the machine, so a VPS can never become a trustchain
member. The `WALLET_PASS` pattern in the docs covers a machine that is *already*
enrolled, which is a different problem.

So we stopped trying to move the ring. The ring stays on the operator's machine. The
remote host generates an ephemeral X25519 keypair and asks to enrol; the device signs
an approval over an **eight-character fingerprint of that key that the operator reads
off the device screen**. Secret releases are then decrypted from the ring locally and
re-encrypted to the approved key, so the plaintext is never on the wire and the ring
never leaves the desk. The VPS ends up holding a short-lived capability rather than a
key — the same property the on-chain grants have.

`keyring-remote/enroll.ts`, with the three failure modes tested in
`keyring-remote/enroll.test.ts` (`npm run test:keyring`): a different host cannot open
a sealed secret, an expired secret is refused, and a request whose fingerprint does not
match its own public key is rejected before the device module is even loaded.

## Developing without hardware

We had no physical device, and four teams asked in Discord over four days whether
Speculos was acceptable with no answer. It works, and the recipe is in
`scripts/speculos.sh` as one command. `scripts/speculos-approve.ts` drives the
prompts, so the mandate and the escalation can both be exercised in CI:

```bash
npm run speculos
npm run speculos:approve &     # answers the prompts
```

Two things had to be fixed to get there, both written up in `FEEDBACK.md`: a DMK
session signs exactly once and must be explicitly disconnected before the next one,
and a declined signature arrives as an error code rather than a rejection.

The key finding is that `@ledgerhq/device-transport-kit-speculos` is a **first-class
DMK transport**, distinct from the `@ledgerhq/speculos-transport` test helper people
were asking about. With it we signed a real EIP-712 mandate on an emulated Nano X and
confirmed the signature recovers to the device address, which means `initRoot` accepts
it.

## Feedback

Full detail with reproduction steps is in `FEEDBACK.md`. The six that cost us time:

1. **The skill-install tip corrupts `--output json`.** `wallet-cli ring keys --output json`
   prints a human-readable tip to stdout ahead of the JSON, so `JSON.parse` throws and
   every consumer has to slice from the first brace. Sending the tip to stderr is a
   one-line fix, and it is ironic that the thing breaking agent integration is an
   advert for agent integration.
2. **`ring` has no typed-data signing, and nothing says so.** `ring` is
   `init | encrypt | decrypt | keys | destroy`. Transaction signing is `wallet-cli send`;
   EIP-712 is in `@ledgerhq/device-signer-kit-ethereum` entirely. The Key Ring page
   never mentions signing lives elsewhere, the signer kit page never mentions the Key
   Ring, and the track page names `ring` without noting it cannot sign. One
   cross-reference line would save every team an hour.
3. **DMK's ESM build breaks Node's native resolver.** `lib/esm/index.js` does
   `export * from "./src"` with no extension, so `node script.mjs` throws
   `ERR_UNSUPPORTED_DIR_IMPORT`. Works under a bundler; does not work under Node.
4. **`signTypedData` returns a bare `6a80` until blind signing is enabled.** The
   emulator screen says *"Blind signing must be enabled in settings"* — the device
   knows the answer and the SDK does not pass it up. Mapping that one error code to
   the device's own message would be a very cheap win.
5. **Speculos ships no app binaries** and nothing points at the `app-ethereum`
   releases page as the place to get one.
6. **Speculos defaults to port 5000, which is AirPlay Receiver on macOS**, so the
   first `docker run` fails with a confusing bind error on every recent Mac.

## What we would say to the team

The Key Ring's framing — *secrets, not coins* — is the right abstraction and it is
what made this project possible. The gap is not capability, it is the story for hosts
that cannot hold a device. Everything needed is already in the box; what is missing is
a page saying "here is how a CI runner or a VPS participates without becoming a
member". We would have built on that page rather than designing around its absence.

---

# ENS

## What we built on ENSv2

Every prior project in this space stored agent policy in ENS text records and enforced
it somewhere else. **We put both in the naming layer.**

`AttenuatedSubregistry` inherits `PermissionedRegistry` and overrides `register()` to
revert. The standard way of minting a name under `attenuate.eth` does not work at all.
The only entry point is `registerWithGrant`, which refuses to mint a subname whose
grant is not a strict subset of its parent's. An over-privileged agent is not rejected
at use time — **it cannot come into existence.**

The ENSv2 features are load-bearing, not decorative:

**Hierarchical registries are the delegation chain.** A registry owns exactly one name
and its direct children, so depth genuinely costs deployments. A name that holds the
`delegate` capability gets its own `AttenuatedSubregistry` derived through a factory at
mint time; a name without it gets no registry at all and is a leaf at the ENS level
regardless of what its grant says.

**Enhanced Access Control splits the roles.** `registerWithGrant` requires
`ROLE_REGISTRAR`; `revokeGrant` requires `ROLE_UNREGISTER`. Whoever can kill a name
cannot mint one. A test exercises the split by having a revoker attempt to grant.

**No child ever receives `ROLE_SET_RESOLVER`.** An agent that can repoint its own
resolver can rewrite the permissions its own name publishes, which would hollow out
the entire claim. We found this from Kevin's answer to another team in the Discord and
removed it the same day.

**Non-transferable comes free.** Withholding `ROLE_CAN_TRANSFER_ADMIN` makes a
permission unsellable. A permission that can be sold is not a permission.

**Expiry and revocation.** Each node stores an epoch and children record their
parent's epoch at grant time, so bumping a parent's epoch invalidates every descendant
in the same block at any depth. Measured at **4,327 gas, identical across subtrees of
1, 3, 7 and 15 descendants** — the cost of a kill switch does not grow with what it
kills.

## What we learned the hard way

**Read the source, not the docs.** They disagree. Search returned
`register(bytes32 label, ...)`, the docs said `string label`, the source says
`string memory label`. More importantly, **no documentation page anywhere states that
`register` is `virtual`** — and that single keyword is what decides whether mint-time
refusal is possible at all. We only found it by cloning `ensdomains/contracts-v2` and
grepping.

Four other things our first design got wrong because we trusted a summary:

- A registry owns one name and its direct children, so there is no `parentNode`
  argument anywhere. Our first spec had one.
- Names are `uint256` ERC1155 token ids, not `bytes32` namehashes.
- EAC roles are bit positions, not `keccak256` strings. We had invented `ROLE_GRANT`
  and `ROLE_REVOKE`, which do not exist.
- The role check reverts with `EACUnauthorizedAccountRoles`, not a string. Our spec
  had `NOT_GRANTOR`, which appears nowhere in the codebase.

## Feedback

**Document that `register` is `virtual`.** It is the single fact that determines
whether custom mint-time logic is possible, and it appears in no doc page. One line on
the Permissioned Registry page — *"`register` is virtual; a custom registry may
override it to add its own checks"* — would have saved us most of day one and would
tell every other team that this whole category of project is available to them.

**Cross-reference the role constants.** `RegistryRolesLib` is the source of truth and
it is not linked from the pages that discuss permissions. Teams arriving with ENSv1
habits will reach for `keccak256("ROLE_X")` and get silent nonsense.

**The hackathon deployment addresses moved mid-event** and the production docs still
listed the old ones. A single canonical page that both humans and agents can poll
would help; we found the change by a teammate noticing failed transactions.

**The `SET_RESOLVER` guidance should be in the docs, not only in Discord.** Kevin's
answer to another team — do not grant `SET_RESOLVER` to subnames you want to constrain
— is the difference between a working permission model and a hollow one. It deserves a
paragraph in the Permissioned Registry docs.

## What we would say to the team

The sentence we kept coming back to: **ENSv1 could store agent policy; ENSv2 can
enforce it.** Hierarchical registries plus Enhanced Access Control let the naming layer
itself refuse to mint an over-privileged child, and nothing before ENSv2 could do that.
That is a much bigger deal for agent infrastructure than it currently reads as in the
docs, which describe the mechanism without naming what it makes possible.

---

# The Graph

## What we built

**An MCP server, which is the actual deliverable.** Six tools, usable by any agent in
any framework with no knowledge of this project. It speaks stdio and responds to a
real MCP client handshake.

The one that matters is `simulate_grant`: hand it a proposed grant and it returns the
exact reason it would be refused **and which field to narrow**, without spending gas.

```
simulate_grant → {"ok":false,"reason":"CAP_EXCEEDS_UNALLOCATED","field":"spendCap",
                  "parent":"attenuate.eth","parentRemaining":"280"}
```

That mapping is the difference between an error a developer can act on and one they
have to read Solidity to understand. `check_scope`, `get_delegation_tree`,
`grant_capability`, `revoke_agent` and `query_position` complete the set, and
`SKILL.md` ships alongside.

**A subgraph that indexes the permission tree itself** — grants, revocations, reclaims,
budget flows, executions, and every blocked escalation with its named reason. It is
deployed against the live Sepolia contracts and answering queries:

```
https://api.studio.thegraph.com/query/1760226/atte/v0.0.1
```

```graphql
{ agents { label capabilities spendCap spendRemaining } }
```

```json
{"label":"risk",  "capabilities":"212", "spendCap":"260000000000000000000", "spendRemaining":"250000000000000000000"}
{"label":"exec",  "capabilities":"84",  "spendCap":"100000000000000000000", "spendRemaining":"100000000000000000000"}
{"label":"probe", "capabilities":"64",  "spendCap":"10000000000000000000",  "spendRemaining":"10000000000000000000"}
```

255 → 212 → 64 is the capability mask narrowing down the tree, read back out of the
index. `probe` is the one that matters for the mapping: it lives in a registry that did
not exist when the subgraph was deployed, so a static address list misses it entirely.
`RegistryAuthorized` spawns a `ChildRegistry` template, which is how a delegation tree
of arbitrary depth stays indexable.

**A push trigger with cursor resumption and reorg handling.** Two sources behind one
interface: Substreams gRPC when a token is configured, chain head otherwise. Both
persist a cursor and both detect reorgs by remembering block hashes across a
confirmation window.

We tested reorg recovery against a **genuinely forced reorg**, not a simulated one:

```
blocks seen 15, cursor persisted at 109
anvil_reorg depth 3 applied
undo callback: revertedTo=106, 3 hashes dropped
stale flag cleared, resumed at 113
```

**x402 paid from the same budget the device authorised.** A gated endpoint answers 402,
the agent pays, the request is retried — and the payment is debited through
`Executor.execute` → `STORE.spendQuery`, the same enforcement path that governs moving
money. There is no separate quota to reconcile:

```
before queryRemaining = 100
402 → paid → retry → data
after  queryRemaining = 99, debited on chain
OVER_QUERY_BUDGET when the grant runs out
```

## The measurement

The Lisbon winner took the track on a number, so we brought two.

**Push versus polling**, both running against the same chain at the same time so the
only variable is how each learns a block exists:

```bash
anvil --block-time 1 &            # the poller needs blocks it can miss
npm run deploy:local
BENCH_BLOCKS=25 npx tsx indexer/benchmark.ts
```

```
blocks observed            25
push median lag             0 ms
polling median lag        593 ms
blocks polling never saw   18
```

Eighteen of twenty-five blocks the poller never observed at all. That is the stronger
half: polling is not merely slower, it *skips* blocks, and every skipped block is a
liquidation the guard could not have acted on. A guard five minutes late is a
preference for an app that displays and a bug for one that spends.

**An LLM proposes, and the registry is what decides.** The planner is given a real
position and a real parent grant, its reply is never filtered in TypeScript, and
whatever it asks for goes straight to `registerWithGrant`.

```bash
GEMINI_API_KEY=... npm run plan     # ANTHROPIC_API_KEY also works
```

Our run, against `gemini-3.6-flash` on positions from a health factor of 0 with debt
ranging from 500 to 5000 USDC:

```
proposed 4 · accepted 4 · blocked 0 · reached execution 0
```

**The model never exceeded its scope.** It is told the parent's `spendRemaining` and it
respected it every time; on the most distressed position it proposed a *zero* spend cap
and asked only for repay. We are reporting that rather than a number we could have
manufactured by withholding the parent's budget from the prompt, because the honest
result is the more useful one: a well-behaved model is the expected case, and a
guarantee that only holds when the model misbehaves is not a guarantee.

The enforcement evidence is therefore not anecdotal. `contracts/test/Escalation.t.sol`
is 21 tests, one per way a child can try to exceed its parent, and all 21 are refused
at mint time. That is exhaustive where a model run is a sample.

`reachedExecution` counts accepted proposals that produced a mint transaction.
Out-of-scope proposals stay at zero because the name is never minted. That refusal
does not depend on which model proposed, or on how well it behaved on the day.

The design line worth stating: structured output constrains the *shape* of the model's
reply so it always parses, and deliberately **not** the scope. Filtering the proposal
in TypeScript would move the safety guarantee into the client, which is the thing this
project argues against.

## Feedback

**Subgraph Studio sign-in was the biggest blocker, and it was not ours alone.** Several
teams reported the same two failures in Discord: verification emails landing in junk
(one person only got through with a non-Outlook address), and the wallet sign-in
failing with a CORS error on `api.studio.thegraph.com/graphql` in some browsers. Brave
plus Rabby worked where Edge plus MetaMask did not. Losing an afternoon to auth before
writing a line of subgraph code is a rough first impression.

**The From Scratch track naming is genuinely ambiguous.** The pinned Discord message
lists *"Best AI Tooling for The Graph"* under From Scratch and *"Best AI Use Case"*
under Continuity, while the prize page shows *"Best AI Tooling or AI Use Case"* for
both pools. Two teams asked which applies to a From Scratch AI use case and neither
got an answer. We built as tooling to be safe, but it changed our priorities for a day
and it would change what other teams build.

**`graph codegen` type mappings are worth documenting in one table.** `uint64` becomes
`BigInt`, `uint8` and `uint16` become `i32`, `uint32` becomes `BigInt`. We lost time to
`BigInt.fromI32(e.params.queryCost)` on a `uint32` that was already a `BigInt`, and the
AssemblyScript compiler crashes rather than giving a type error, so the message points
at nothing useful.

**The `.ts` extension on mapping files is a trap.** Editors offer TypeScript
completions for AssemblyScript, so `return s as Stats` on a nullable type-checks in the
editor and crashes the compiler. A note near the top of the mappings docs would help.

## What we would say to the team

Indexing the permission tree turned out to be the thing that made the whole project
auditable. *"What did this agent try to do that it was not allowed to do"* is a
question nobody can normally answer, and a subgraph over refused grants answers it in
one query. That felt like a use of The Graph that is about accountability rather than
analytics, and we would like to see more of it.
