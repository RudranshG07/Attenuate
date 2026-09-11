# AI use

Required by the ETHOnline rules. This records where AI tools were used, on which
files, and who authored what.

## Tools

| Tool | Used for |
|---|---|
| Claude Code (Claude Opus 5) | Paired with on ENS and Ledger integration, the broker, the MCP server handlers, the planner, the subgraph and the web app. Also used to research ENSv2 and the Ledger stack against source, and to review contract changes. |
| Claude Opus 5 via the API | Runtime component, not a build tool: `agent/planner.ts` calls it to propose a child grant. See the note below. |

## By directory

| Path | Author | AI involvement |
|---|---|---|
| `contracts/src/` | Jnyandeep | Initial skeletons and `GrantStore` paired with Claude Code; `SubregistryFactory`, the role split, and the current shape of all four contracts authored by Jnyandeep |
| `contracts/test/` | Jnyandeep | `Attenuation.t.sol` paired with Claude Code; the escalation suite, conservation invariant and gas harness authored by Jnyandeep |
| `contracts/script/` | Jnyandeep | Authored by Jnyandeep |
| `broker/` | RudyG07 | Paired with Claude Code throughout |
| `agent/planner.ts` | Adish7Pandya, RudyG07 | Types and system prompt by Adish7Pandya; the API call, logging and stats paired with Claude Code |
| `agent/monitor.ts`, `agent/decide.ts` | RudyG07 | Paired with Claude Code |
| `mcp-server/index.ts` | Adish7Pandya, RudyG07 | Tool definitions and schemas by Adish7Pandya; handler implementations paired with Claude Code |
| `mcp-server/SKILL.md` | Adish7Pandya, RudyG07 | Drafted with Claude Code, completed by Adish7Pandya |
| `indexer/` | Adish7Pandya, RudyG07 | Benchmark shape by Adish7Pandya |
| `subgraph/` | RudyG07 | Paired with Claude Code |
| `web/` | RudyG07 | Paired with Claude Code |
| `scripts/` | RudyG07, Jnyandeep | `speculos.sh` and `deploy-local.ts` paired with Claude Code; `deploy-fork.ts` and the current `deploy-local.ts` by Jnyandeep |
| `README.md` | RudyG07 | Paired with Claude Code |

Jnyandeep and Adish7Pandya should amend their own rows if they used other tools.

## The model is also a runtime component

This is worth separating from build-time assistance, because it is the point of the
project rather than a convenience.

`agent/planner.ts` calls Claude Opus 5 at runtime to propose what a sub-agent should
be allowed to do. The model is **not trusted**: its output is never filtered in
TypeScript, every proposal is submitted to the chain, and the registry refuses
anything outside the parent's scope. Refusals are logged, and the count is a
published metric.

The structured-output schema constrains the **shape** of the reply so it always
parses. It deliberately does **not** constrain the scope. Filtering the model's
proposal client-side would move the safety guarantee into the client, which is the
thing this project argues against.

## Human contribution

All three of us have authored commits throughout. `git shortlog -sn` shows the split.
Design decisions, the contract architecture, the role model, and every judgement call
about what to build were ours; AI was used for research against source, implementation
of agreed designs, and review.
