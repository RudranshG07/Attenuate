# 03 — MCP server and planner brief

Handed to the AI/data lane.

## Why the MCP server, not the agent, is the deliverable

The From Scratch pool we qualify for is **Best AI Tooling for The Graph**. "AI use
case" is the Continuity pool. So the MCP server is the eligibility gate, not a bonus,
and the planner is evidence the tooling is good rather than the entry ticket.

Asked for six tools. `simulate_grant` is the one an outside developer actually
reaches for: hand it a proposed grant, get back the exact reason it would be refused
and which field to narrow, without spending gas.

## The counterintuitive instruction

> Do not prompt-engineer the model into always producing valid grants. We want it to
> sometimes over-reach. Every refusal is the demo, and the published number is "the
> model proposed N grants, M exceeded scope, all M blocked at mint time, 0 reached
> execution". Log every proposal, accepted or refused. The refusals are the product,
> not the bugs.
>
> Never filter the model's output in TypeScript before submitting it. That puts the
> safety back in the client, which is the exact thing we are arguing against.

This runs against an ML instinct to reduce error rate, so it was stated twice.

## Where the line actually sits

Structured output constrains the **shape** of the reply so it always parses. It does
**not** constrain the scope. The model may ask for capabilities its parent lacks, and
the registry refuses. That distinction is the whole design.

## Result

`plannerStats()` reads the proposal log back:

```
proposed 5 · accepted 2 · blocked 3 · reachedExecution 0
byReason: SCOPE_WIDENED 1, CAP_EXCEEDS_UNALLOCATED 1, DEPTH_EXCEEDED 1
```

`reachedExecution` counts accepted proposals that produced a mint transaction.
Out-of-scope grants stay at zero because the name is never minted.
