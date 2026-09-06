# Attenuate

An AI agent that manages your onchain position, and the permission layer that
makes it safe to hand it real money.

ETHOnline 2026, Classic "From Scratch" track.

TODO: pitch paragraph, demo video, live demo

## The claim

Storing agent policy in ENS has been done. Enforcing attenuation in the registry
hierarchy itself has not.

Every agent is an ENSv2 subname. Its scope, budget and expiry live in its own
Permissioned Resolver, and `AttenuatedSubregistry.register()` refuses to mint a
subname whose grant is not a subset of its parent's. An over-privileged name is
never created.

## Guarantees

1. Attenuation is structural. An over-privileged subname cannot come into existence.
2. The root is hardware. One EIP-712 mandate signed on a Ledger Key Ring.
3. Revocation is instant and total. One SSTORE kills a subtree in the same block.

## Architecture

TODO

## Metrics

| Metric | Value |
|---|---|
| Escalation scenarios blocked | / 20 |
| Attenuation fuzz runs | |
| Conservation invariant | |
| Gas per grant | |
| Gas per revocation | |
| Root-to-leaf revocation latency | |
| Max delegation depth | |
| Substreams vs polling trigger lag | |
| Liquidation events polling missed | |
| LLM grant proposals blocked at mint time | / |

## Limitations

1. Budgets are denominated in a single asset. Cross-asset attenuation needs
   per-asset remaining balances and an oracle.
2. `amountArgIndex` reads a flat uint256 at a fixed calldata word. Struct-encoded
   router params need a per-capability decoder.
3. Reclaiming a dead subtree is one call per node.
4. `MAX_WALK` caps depth at 8. `isLive` fails closed beyond it.
5. The Executor holds the funds. Per-agent accounts would be the production shape.

## Bugs we found in our own spec

The escalation suite grew from 12 cases to 20 after a second pass on the spec.
Three of the additions were real holes:

- The spend cap metered only `msg.value`, so ERC20 actions with `value == 0`
  were unconstrained.
- `readOnly` only checked `value == 0`, so a read-only grant could still call
  `repay` or `approve`.
- The query budget was checked against the parent's total rather than its
  unallocated remainder.

## Prior art

TODO: ENSFirewall, WorkAgnt DelegateFlow, ACN, HumanENS, AgentArena,
AWS sample-agentic-delegation

## Ours vs libraries

TODO

## Setup

TODO

## Layout

| Path | |
|---|---|
| `contracts/` | Attenuation invariant, epoch revocation, calldata metering |
| `broker/` | Key Ring wrapper, EIP-712 mandate, calldata builder |
| `keyring-remote/` | Key Ring on a host with no USB port |
| `agent/` | Monitor, planner, act/delegate/escalate |
| `mcp-server/` | MCP server and SKILL.md |
| `subgraph/` | Indexes the permission tree |
| `indexer/` | Substreams trigger, benchmark |
| `web/` | Tree view |
