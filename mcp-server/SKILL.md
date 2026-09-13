---
name: attenuate
description: This skill should be used when the user asks to give an AI agent onchain spending permissions, delegate a capability to a sub-agent, scope or cap what an agent may spend, revoke an agent's access, build a permission hierarchy for autonomous agents, or debug why a delegated grant was refused. Also use when the user mentions capability attenuation, agent spend caps, least-privilege delegation, ENS-based agent identity, or asks how to safely hand an autonomous agent real money.
version: 0.1.0
---

# Attenuate

Delegate scoped, budgeted, revocable onchain capabilities to sub-agents. A child grant can never exceed its parent, and the check runs in the registry contract, not in the client.

## Overview

An agent that holds a private key holds everything. The moment it delegates to a sub-agent, that authority leaks. Attenuate replaces the key with a **grant**: a bitmask of capabilities, a spend cap, a query budget, an expiry, and a delegation depth, attached to an ENS name.

Three properties make the delegation safe:

**Attenuation is structural.** `registerWithGrant` refuses to mint a subname whose grant is not a subset of its parent's. An over-privileged agent is not rejected at use time; it never comes into existence.

**Budgets are allocated, not copied.** Granting a child debits the parent immediately. A parent holding 100 cannot give 100 to two children. The sum over the tree can never exceed the root mandate.

**Revocation is instant and total.** Each node stores an epoch, and children record their parent's epoch when granted. Bumping a parent's epoch is one storage write that kills every descendant in the same block, at any depth.

## When to use this

- Handing an agent a budget it can spend without handing it a key
- Splitting work to a sub-agent that must be strictly less privileged
- Killing an agent and everything it spawned, immediately
- Working out why a grant was refused

## When not to use this

- Granting permissions to a human. This models machine delegation; use a multisig.
- Anything needing per-asset budgets. Grants are denominated in a single asset (see Limitations).
- Off-chain-only permissions. Enforcement is a contract call, so it costs gas.

## Core concepts

### The Grant

```solidity
struct Grant {
    uint256 capabilities;     // bitmask, one bit per allowed action
    uint256 spendCap;         // ceiling, in the registry's budget asset
    uint256 spendRemaining;   // unallocated + unspent
    uint256 queryBudget;      // x402 units for paid data
    uint256 queryRemaining;
    uint64  expiry;
    uint16  maxDepth;         // further delegation hops allowed
    bool    readOnly;
    bytes32 parent;
    uint64  parentEpochAtGrant;
    uint64  epoch;
}
```

### The attenuation invariant

Every field must narrow. This is the whole contract:

```solidity
require(c.capabilities & p.capabilities == c.capabilities, "SCOPE_WIDENED");
require(c.spendCap    <= p.spendRemaining, "CAP_EXCEEDS_UNALLOCATED");
require(c.queryBudget <= p.queryRemaining, "BUDGET_EXCEEDS_UNALLOCATED");
require(c.expiry      <= p.expiry,         "EXPIRY_EXTENDED");
require(c.maxDepth     < p.maxDepth,       "DEPTH_EXCEEDED");
require(!p.readOnly || c.readOnly,         "READONLY_ESCALATION");
```

`c & p == c` is the subset test. Any bit the child sets that the parent lacks is dropped by the AND, so equality fails and the call reverts.

Note `spendRemaining`, not `spendCap`. Checking against the total is the bug that lets a parent hand its full budget to two different children.

`maxDepth` uses strict `<`, so a parent at depth 0 cannot delegate at all. That is the intended leaf condition.

### Two enforcement points

Names store permissions; they do not intercept transactions. Enforcement happens twice, and conflating them is the most common misunderstanding:

| Point | What it stops |
|---|---|
| `registerWithGrant` | an over-privileged name existing |
| `Executor.execute` | an action outside the resolved grant |

The registry refuses to mint escalation. The executor trusts what the registry resolved and checks the action against it.

### Capability bits

Each bit maps to exactly one `(target, selector)` pair, plus the calldata word carrying its amount so spend can be metered.

| Bit | Capability | Read-safe |
|---|---|---|
| 0 | `swap.uniswap` | no |
| 1 | `lend.aave.supply` | no |
| 2 | `lend.aave.repay` | no |
| 3 | `lend.aave.withdraw` | no |
| 4 | `erc20.approve` | no |
| 5 | `transfer.native` | no |
| 6 | `data.graph.read` | yes |
| 7 | `delegate` | yes |

A grant without bit 7 cannot call `registerWithGrant` at all, so it is a leaf regardless of `maxDepth`.

`readOnly` grants may invoke only read-safe bits. Checking that value is zero is not enough: `repay` and `approve` both move tokens with zero native value.

## Setup

```bash
npm i @modelcontextprotocol/sdk
```

```bash
npx @attenuate/mcp-server
```

```json
{
  "mcpServers": {
    "attenuate": {
      "command": "npx",
      "args": ["-y", "@attenuate/mcp-server"],
      "env": {
        "ATTENUATE_RPC_URL": "https://sepolia.infura.io/v3/KEY",
        "ATTENUATE_ROOT": "yourname.eth",
        "ATTENUATE_PRIVATE_KEY": "0x..."
      }
    }
  }
}
```

`ATTENUATE_PRIVATE_KEY` is the key of the agent acting as grantor. It is only ever used to sign the grant transaction; the sub-agents it creates never receive it.

## Limitations

- Grants support a single budget asset.
- Metering currently covers flat function arguments only.
- Reclaim is manual after revocation; unspent budget is not returned automatically.

## Tools

### `simulate_grant`

Dry-run a proposed grant. Returns the named reason it would be refused. Costs nothing.

Capabilities are the same names `check_scope` reports, and amounts are in the same
whole-token units it reports them in, so a reading can be fed straight back without
knowing bit positions or decimals. A bitmask string still works if you have one, and
`readOnly` defaults to false.

**Call this before `grant_capability`, every time.** A refused grant is a wasted transaction and a wasted block of latency, and the reason string tells you exactly which field to narrow. It is also the right tool when a model proposes a grant: check first, then act.

```
Input:  { parent: "risk.attenuate.eth",
          grant: { capabilities: ["lend.aave.repay", "erc20.approve"],
                   spendCap: "9999", queryBudget: "1",
                   expiry: 1789298161, maxDepth: 0 } }

Output: { ok: false,
          reason: "CAP_EXCEEDS_UNALLOCATED",
          field: "spendCap",
          parent: "risk.attenuate.eth",
          parentRemaining: "250" }
```

### `grant_capability`

Mint a subname with a grant attached. Reverts if the grant does not attenuate.

```
Input:  { parent: "agent.eth", label: "exec", owner: "0x...",
          grant: { ... } }
Output: { ok: true, name: "exec.agent.eth", tokenId: "...", txHash: "0x..." }
```

On failure the reason is the same string `simulate_grant` would have returned.

### `check_scope`

What may this name actually do, right now. Resolves the full parent chain, so a name whose grandparent was revoked reports `live: false` even though its own record looks healthy.

```
Input:  { name: "exec.agent.eth" }
Output: { live: true, capabilities: ["lend.aave.repay"],
          spendRemaining: "250000000", queryRemaining: "800",
          expiry: 1757462400, depth: 2, maxDepth: 0 }
```

Call this before acting, not after. A grant can die between when you read it and when you use it.

### `get_delegation_tree`

The full subtree under a name, including revoked nodes and blocked escalation attempts.

```
Input:  { root: "agent.eth", includeRevoked: true }
Output: { nodes: [...], escalations: [
            { label: "exec", reason: "SCOPE_WIDENED", timestamp: ... } ] }
```

The `escalations` array is the audit trail. Every refused grant is recorded onchain with its reason, so you can answer "what did this agent try to do that it was not allowed to do."

### `revoke_agent`

Bump the epoch. Kills the name and every descendant in the same block.

```
Input:  { name: "exec.agent.eth" }
Output: { ok: true, epoch: 2, descendantsKilled: 3, txHash: "0x..." }
```

Unspent budget is not returned automatically. Call `reclaim` on each dead node to sweep it back to the nearest live ancestor. Revocation is O(1) by design; only the bookkeeping is lazy.

### `query_position`

Read the live lending position from the configured pool. If `ATTENUATE_PRIVATE_KEY` or `BROKER_KEY` is set, the read is paid by `Executor.execute` on `data.graph.read`, which debits `queryRemaining`. If `GRAPH_SUBGRAPH_URL` is set, the indexed tree is queried as well.

```
Input:  { name: "risk.agent.eth", protocol: "aave-v3", account: "0x..." }
Output: { healthFactor: 1.34, collateralUsd: "...", debtUsd: "...",
          queryRemaining: "799" }
```

The budget spent on data is the same budget the grant authorises. There is no separate quota to reconcile.

## Refusal reasons

Every refusal names one field. Narrow that field and retry.

| Reason | Meaning | Fix |
|---|---|---|
| `SCOPE_WIDENED` | child set a capability bit the parent lacks | `child.capabilities &= parent.capabilities` |
| `CAP_EXCEEDS_UNALLOCATED` | spendCap exceeds the parent's *unallocated* remainder | lower spendCap, or revoke a sibling and reclaim |
| `BUDGET_EXCEEDS_UNALLOCATED` | same, for queryBudget | lower queryBudget |
| `EXPIRY_EXTENDED` | child outlives the parent | clamp to `parent.expiry` |
| `DEPTH_EXCEEDED` | `maxDepth >= parent.maxDepth` | set `parent.maxDepth - 1`; if parent is 0, it cannot delegate |
| `READONLY_ESCALATION` | read-only parent granting a writable child | set `readOnly: true` |
| `PARENT_DEAD` | parent revoked or expired | check `check_scope` on the parent first |
| `NOT_GRANTOR` | caller lacks the registrar role | the grantor must own the parent name |
| `OVER_BUDGET` | at execute time, amount exceeds `spendRemaining` | split into smaller actions or request a larger grant |
| `TARGET_MISMATCH` | capability bit valid, contract address wrong | each bit authorises exactly one target |
| `REVOKED_OR_EXPIRED` | at execute time, some ancestor died | the whole chain must be live |

`CAP_EXCEEDS_UNALLOCATED` is the one that surprises people. The parent may show a large `spendCap` and still refuse, because earlier children already claimed it. Read `spendRemaining`, not `spendCap`.

## Worked example

An agent watching a lending position needs to repay debt before liquidation. It delegates a narrow, short-lived grant rather than acting with its own full authority.

```
1. check_scope("agent.eth")
   -> capabilities [supply, repay, approve, delegate],
      spendRemaining 1000 USDC, maxDepth 2, expiry +30d

2. simulate_grant, proposing a child that can only repay,
   250 USDC, expires in 10 minutes, cannot delegate further:
     capabilities 0x04, spendCap 250e6, expiry now+600, maxDepth 0
   -> { ok: true }

3. grant_capability -> exec.agent.eth
   agent.eth spendRemaining drops to 750 immediately

4. the sub-agent runs as its own process with its own key,
   resolves exec.agent.eth, and calls Executor.execute.
   Any action outside bit 2, or above 250 USDC, reverts.

5. revoke_agent("exec.agent.eth") once the repayment confirms
```

Step 2 is the important one. If a model proposed `capabilities: 0xFF` here, `simulate_grant` returns `SCOPE_WIDENED` and nothing reaches the chain. The model proposes; the registry disposes.

## Notes for agent authors

**Sub-agents must be separate processes with their own keys.** A function call with a name attached inherits the parent's authority and defeats the entire model. The grant is only meaningful if the thing holding it cannot reach the parent's key.

**Always `simulate_grant` before `grant_capability`.** Free, immediate, and the reason string is more useful than a revert trace.

**Re-check scope immediately before acting.** Between reading a grant and using it, an ancestor may have been revoked. `check_scope` walks the whole chain; a local record is not enough.

**Grant the minimum expiry you can tolerate.** Expiry is the cheapest safety property here: it needs no transaction to take effect.

## Limitations

1. **Single budget asset.** Grants are denominated in one asset. Cross-asset attenuation needs per-asset balances and a price oracle.
2. **Flat-argument metering.** The amount is read from a fixed calldata word, so struct-encoded router parameters need a per-capability decoder.
3. **Reclaim is manual.** Sweeping a dead subtree is one call per node.
4. **Depth capped at 8.** Beyond that, liveness checks fail closed.

## Reference

Contracts, tests and the deployment script: https://github.com/RudranshG07/Attenuate
