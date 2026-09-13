# Attenuate

**An agent you can actually fund, because a name is a permission and a child name can never hold more power than its parent.**

ETHOnline 2026 · ENSv2 on Sepolia · Ledger Key Ring · The Graph

---

## The problem

An AI agent that manages money needs a key, and a key is all or nothing. There is no way to say *this agent may spend 200 USDC repaying my Aave loan and nothing else*. And the moment that agent delegates to a sub-agent, the sub-agent inherits the same key, so whatever limits you had in mind are gone.

## What this is

Permissions become names. Every agent is an ENSv2 subname carrying a **grant**: a capability bitmask, a spend cap, a query budget, an expiry, and how many further hops it may delegate.

A child's grant must be a strict subset of its parent's, and that check runs inside the registry contract. Ask for one capability your parent lacks, or one wei more than your parent has left, and **the subname cannot be minted**. Not rejected afterwards. It never exists.

```solidity
require(c.capabilities & p.capabilities == c.capabilities, "SCOPE_WIDENED");
require(c.spendCap    <= p.spendRemaining, "CAP_EXCEEDS_UNALLOCATED");
require(c.queryBudget <= p.queryRemaining, "BUDGET_EXCEEDS_UNALLOCATED");
require(c.expiry      <= p.expiry,         "EXPIRY_EXTENDED");
require(c.maxDepth     < p.maxDepth,       "DEPTH_EXCEEDED");
require(!p.readOnly || c.readOnly,         "READONLY_ESCALATION");
```

Three properties follow:

**Attenuation is structural.** We inherit ENSv2's `PermissionedRegistry` and override `register()` to revert. The standard way of minting a name under ours does not work at all; the only entry point runs the subset check first.

**Budgets are allocated, not copied.** Granting a child debits the parent immediately, so a parent holding 1000 cannot hand 1000 to two children. Proven by a stateful invariant, not asserted.

**Revocation is instant and total.** Each node stores an epoch and children record their parent's epoch at grant time. Bumping a parent's epoch is one storage write and every descendant is dead in the same block, at any depth.

The root exists only because a human signed one EIP-712 mandate on a Ledger. There is no owner function that can seed it.

## The AI part

An LLM decides what each sub-agent should be allowed to do. It is **not trusted**, and its output is never filtered in the client. Every proposal goes through `registerOrLog`: in-scope proposals mint a subname, out-of-scope ones are refused at mint time and written to the chain with the named reason.

This is agent containment demonstrated rather than asserted. The guarantee does not come from the model behaving well; it comes from an over-privileged grant being structurally unrepresentable.

## Metrics

| | |
|---|---|
| Tests passing | **86** across 7 suites, none skipped |
| Escalation scenarios blocked | **21 / 21**, each with its named revert |
| Revoke gas, 1 descendant | 4,327 |
| Revoke gas, 3 descendants | 4,327 |
| Revoke gas, 7 descendants | 4,327 |
| Revoke gas, 15 descendants | **4,327** |
| `isLive` by depth | 2,952 at depth 1 rising to 10,686 at depth 7 |
| `isLive` past `MAX_WALK` | bounded at 11,310, fails closed |

Revocation cost is **flat across a 15-node subtree**. Liveness is O(depth) and capped, never O(subtree). That is the whole kill-switch argument in two numbers.

## Running it

```bash
git clone --recursive https://github.com/RudranshG07/Attenuate.git
cd Attenuate && npm install
cd contracts && forge build && forge test
```

`--recursive` matters: dependencies are git submodules.

Local demo, four commands:

```bash
npm run chain          # anvil
npm run deploy:local   # contracts, device-signed root mandate, and a three-level tree
npm run smoke          # end-to-end: grant, execute, refuse, revoke, reclaim
npm run web            # localhost:3000
```

Against a fork of real Sepolia, using the live ENSv2 LabelStore:

```bash
anvil --fork-url $SEPOLIA_RPC_URL
npx tsx scripts/deploy-fork.ts
```

Emulated Ledger, no hardware needed:

```bash
./scripts/speculos.sh             # Speculos with blind signing enabled
```

## Live on Sepolia

`attenuate.eth` is registered on the ENSv2 hackathon deployment, and every grant in the
tree is published as text records on its own permissioned resolver.

```
$ cast call 0x983c610f91Faa00949943a132650167bf41F440A \
    'text(bytes32,string)(string)' $(cast namehash risk.attenuate.eth) grant.caps
"0xd4"
```

| | |
|---|---|
| Name | `attenuate.eth` (ENSv2 hackathon registry, not the public ENS app) |
| Resolver | [`0x983c…440A`](https://sepolia.etherscan.io/address/0x983c610f91Faa00949943a132650167bf41F440A) |
| GrantStore | `0x1e84432141f3fc1f14ebffc801aa020330d3fea9` |
| AttenuatedSubregistry | `0x2f843fbf91b9f26909f171379db47596c83b10dd` |
| Executor | `0x540a26dfcadf9b93225b7d0d61f6ac2646674ac3` |
| Deployed at block | `11690689` |
| Subgraph | [`atte/v0.0.1`](https://api.studio.thegraph.com/query/1760226/atte/v0.0.1) |

The published tree, read straight off the resolver:

```
attenuate.eth              caps=0xff  cap=1000  remaining=640  budget=852/1000
risk.attenuate.eth         caps=0xd4  cap=260   remaining=250  budget=100/140
exec.attenuate.eth         caps=0x54  cap=100   remaining=100  budget=8/8
probe.risk.attenuate.eth   caps=0x40  cap=10    remaining=10   budget=40/40
```

`0xff → 0xd4 → 0x40` is the capability mask narrowing on every hop, and a parent's
`remaining` drops as its children are minted: 640 = 1000 − 260 − 100. Nothing off-chain
is involved in either number.

Point the whole stack at it:

```bash
ATTENUATE_DEPLOYMENT=sepolia npm run web
```

Reproduce the deployment:

```bash
LIVE=1 RPC_URL=$SEPOLIA_RPC_URL npx tsx scripts/deploy-sepolia.ts
```

## Sub-agents are processes, not function calls

Every name holds a key of its own. `Executor.execute` requires
`msg.sender == STORE.agentOf(node)`, so a name is only usable by whoever holds it —
delegation that can be watched rather than described.

```bash
npm run agent exec  repay 5      # holds lend.aave.repay
npm run agent probe repay 5      # read-only leaf
ATTENUATE_AGENT_SEED=someone-else npm run agent exec repay 5
```

```
agent exec.attenuate.eth   pid 25439  key 0xe160…e06e  holds true   EXECUTED repay
agent probe.attenuate.eth  pid 25464  key 0x8190…f091  holds true   REFUSED  CAP_MISSING
agent exec.attenuate.eth   pid 25505  key 0x42E2…11ab  holds false  REFUSED  NOT_AGENT
```

Separate processes, separate keys, three different outcomes decided on chain. `probe`
is refused because its grant never held the capability; the third is refused because
holding the name is not the same as knowing about it.

`probe` is also minted *by risk's key*, not the deployer's: risk is the registrar of
the registry under its own name, so the deployer could not mint there if it tried.

## What each partner does here

**ENS.** Every prior project in this space stored agent policy in ENS text records and enforced it somewhere else. We inherit `PermissionedRegistry`, override the mint, and use hierarchical registries as the delegation chain itself. Enhanced Access Control splits granting from revoking, and withholding `ROLE_CAN_TRANSFER_ADMIN` makes a permission non-sellable. No child ever receives `ROLE_SET_RESOLVER`, because an agent that can repoint its own resolver can rewrite the permissions its name publishes.

**Ledger.** One EIP-712 mandate signed on device is the only way the tree can exist. The broker releases scoped, expiring capabilities to sub-agents through the Key Ring and never a key. Development runs against Speculos, headless, with a one-command setup script.

**The Graph.** A subgraph indexes the permission tree itself, so any agent's full history of grants, spends and refusals is one query. The MCP server lets any agent in any framework delegate under enforced budgets without ever seeing this project.

## Layout

| Path | |
|---|---|
| `contracts/` | `GrantStore` holds state and the rule, `AttenuatedSubregistry` is the ENS-facing half, `Executor` is use-time enforcement, `CapabilityRegistry` maps bits to calls |
| `broker/` | Key Ring wrapper, EIP-712 mandate, calldata builder. Decides nothing. |
| `agent/` | Position monitor, LLM planner, act / delegate / escalate |
| `mcp-server/` | Six tools and a published `SKILL.md` |
| `subgraph/` | Indexes grants, refusals, budget flows and executions |
| `indexer/` | Substreams trigger and the benchmark |
| `web/` | One screen: the tree by name, live budget bars, the activity feed |

## Known limitations

Stated openly, because a reviewer finds these in ninety seconds.

1. **Single budget asset.** Cross-asset attenuation needs per-asset balances and a price oracle.
2. **Flat-argument metering.** The spend amount is read from a fixed calldata word, so struct-encoded router parameters need a per-capability decoder.
3. **Reclaiming a dead subtree is one call per node.** A batched sweep is straightforward but unbuilt.
4. **`MAX_WALK` caps depth at 8.** Liveness fails closed beyond it.
5. **The Executor holds the funds.** A production design would use per-agent accounts. The permission model is unchanged either way.

## Bugs we found in our own design

The escalation suite grew from 12 cases to 21 because later passes found real holes. Three of them mattered:

- The spend cap metered only `msg.value`, so every ERC20 action in the demo moved tokens with `value == 0` and the budget constrained nothing.
- `readOnly` only checked `value == 0`, so a read-only agent could still call `repay` or `approve`.
- The query budget was compared against the parent's total rather than its unallocated remainder, the same double-spend already fixed for money.

## Prior art

| Project | What it did | Why this differs |
|---|---|---|
| ENSFirewall | Policy in ENS text records, enforced by ERC-4337 accounts | Policy in ENS, enforcement elsewhere. ENSv1. |
| WorkAgnt DelegateFlow | Sub-agent delegation via ERC-7710 | Token-based. We delete the token layer. |
| ACN, HumanENS, AgentArena | Agent subnames for identity and discovery | No attenuation. ENSv1. |
| AWS sample-agentic-delegation | Cedar attenuation with chain-hash tamper detection | Correct pattern, entirely off chain. |

Storing agent policy in ENS has been done. Enforcing attenuation in the registry hierarchy itself has not.

## Ours vs libraries

Written for this hackathon: all four contracts, the full test suite, the broker, the agent, the MCP server, the subgraph, the indexer and the web app.

Dependencies used as-is: `ensdomains/contracts-v2` (ENSv2, inherited from), OpenZeppelin (ECDSA and EIP712), `forge-std`, viem, Next.js, `@ledgerhq/device-management-kit` and the Ethereum signer kit, `@modelcontextprotocol/sdk`, and `@graphprotocol/graph-ts`.

## Team

| | |
|---|---|
| RudyG07 | ENS integration, Ledger and Speculos, broker, subgraph, web |
| Jnyandeep | Contracts, test suite, gas harness, deploy scripts |
| Adish7Pandya | MCP tool definitions, SKILL.md, planner types, benchmark |
