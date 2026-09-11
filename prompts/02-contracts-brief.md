# 02 — Contracts brief

Handed to the contracts lane, alongside the verified ENSv2 notes from `01`.

## The invariant, and the two lines that look like typos

```solidity
require(c.capabilities & p.capabilities == c.capabilities, "SCOPE_WIDENED");
require(c.spendCap    <= p.spendRemaining, "CAP_EXCEEDS_UNALLOCATED");
require(c.queryBudget <= p.queryRemaining, "BUDGET_EXCEEDS_UNALLOCATED");
require(c.expiry      <= p.expiry,         "EXPIRY_EXTENDED");
require(c.maxDepth     < p.maxDepth,       "DEPTH_EXCEEDED");
require(!p.readOnly || c.readOnly,         "READONLY_ESCALATION");
```

Compare against `spendRemaining`, never `spendCap`. Comparing against the total is
what would let a parent hand its whole budget to two different children. Same for
`queryRemaining`. `maxDepth` uses a strict `<` so a parent at depth 0 can never grant,
which is the intended leaf condition.

## Non-negotiable

Enforcement lives in Solidity. There is a TypeScript broker that builds calldata and
it must never decide whether a grant is legal. Putting the subset check there is
easier and would make the whole project theatre.

## Asked for

- The 20 named escalation scenarios, each reverting with its exact reason
- A stateful conservation invariant fuzzing grant / revoke / reclaim / spend in random
  order, asserting the live tree never exceeds the root mandate
- Gas numbers: per grant, per revoke, and proof that revoke does not scale with
  subtree size
- Deploy script

## What came back, and what it changed

The contracts lane delivered all of it, plus a 21st scenario nobody specified
(`approve` aimed at an unpinned spender), and improved the design in three ways worth
recording:

- `assertCanGrant` moved ahead of the registry deployment, so a refused grant does not
  pay for a deployment
- `revokeGrant` moved onto `ROLE_UNREGISTER`, so whoever can kill a name cannot mint one
- The child receives **no roles at all** on its own name, which is stricter than the
  brief asked for and closes the resolver-repointing hole

The gas harness produced the headline number: revoke is flat at 4,327 gas across
subtrees of 1, 3, 7 and 15 descendants.
