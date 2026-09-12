# AI use

Required by the ETHOnline rules. This records where AI tools were used, on which
files, and who authored what.

## Tools

| Tool | Used for |
|---|---|
| Claude Code (Claude Opus 5) | Paired with on ENS and Ledger integration, the broker, the MCP server handlers, the planner, the subgraph and the web app. Also used to research ENSv2 and the Ledger stack against source, and to review contract changes. |
| Cursor | Jnyandeep paired with it to research ENSv2 against `ensdomains/contracts-v2` (there is no official `IENSv2` interface), restore the Foundry build, make delegation structural via `SubregistryFactory`, fill the escalation / conservation / gas suites, and get a working local and Sepolia-fork deploy path. |
| Claude Opus 5 via the API | Runtime component, not a build tool: `agent/planner.ts` calls it to propose a child grant. See the note below. |

## By directory

| Path | Author | AI involvement |
|---|---|---|
| `contracts/src/` | Jnyandeep | Early skeletons and `GrantStore` started with Claude Code. The current shape — `SubregistryFactory`, factory-deployed child registries, `revokeGrant`, query metering, and the role split — paired with Cursor after reading ENSv2 source. Judgement calls (a registry cannot embed its own initcode; withhold `ROLE_SET_RESOLVER` / `ROLE_SET_SUBREGISTRY` on children) were Jnyandeep's. |
| `contracts/src/interfaces/IENSv2.sol` | Jnyandeep | Cursor confirmed there is no official `IENSv2`; the live types are `IRegistry` / `IPermissionedRegistry`. The leftover placeholder is unused. |
| `contracts/test/` | Jnyandeep | `Attenuation.t.sol` started with Claude Code. Escalation suite (21 named scenarios with the revert the contract actually emits), conservation invariant, gas harness, and the rewritten depth-2 delegation tests paired with Cursor. |
| `contracts/script/` | Jnyandeep | `Deploy.s.sol` paired with Cursor. |
| `contracts/foundry.toml` | Jnyandeep | ENSv2 remappings and `skip = ["lib/**"]` paired with Cursor so a nested `contracts-v2` checkout does not get compiled as ours. |
| `broker/` | RudyG07, Jnyandeep | Core broker (mandate, Key Ring, grant encoding, device) paired with Claude Code throughout. Fork addresses and type / deploy-time wiring in `chain.ts`, `types.ts`, `grant.ts` and `client.ts` paired with Cursor. |
| `keyring-remote/` | RudyG07 | Paired with Claude Code. |
| `agent/planner.ts` | Adish7Pandya, RudyG07 | Types and system prompt by Adish7Pandya; the API call, logging and stats paired with Claude Code. |
| `agent/monitor.ts`, `agent/decide.ts` | RudyG07 | Paired with Claude Code. |
| `mcp-server/index.ts` | Adish7Pandya, RudyG07 | Tool definitions and schemas by Adish7Pandya; handler wiring paired with Claude Code. |
| `mcp-server/handlers.ts`, `mcp-server/tree.ts` | RudyG07 | Paired with Claude Code. |
| `mcp-server/SKILL.md` | Adish7Pandya, RudyG07 | Drafted with Claude Code, completed by Adish7Pandya. |
| `indexer/` | Adish7Pandya, RudyG07 | Benchmark shape by Adish7Pandya; Substreams / head trigger and the push-vs-polling harness paired with Claude Code. |
| `subgraph/` | RudyG07 | Paired with Claude Code. |
| `web/` | RudyG07 | Paired with Claude Code. |
| `scripts/` | RudyG07, Jnyandeep | `speculos.sh` and the first `deploy-local.ts` paired with Claude Code. Current `deploy-local.ts`, `deploy-fork.ts` and `smoke.ts` rewritten with Cursor so a three-level tree actually deploys and the Sepolia fork talks to live ENSv2. |
| `package.json`, `package-lock.json` | Jnyandeep | Forge / subgraph scripts and lockfile hygiene paired with Cursor. |
| `.gitignore` | Jnyandeep | `/lib/` ignore (root leftover `forge install`, not `contracts/lib/` submodules) paired with Cursor. |
| `prompts/` | RudyG07 | Planning artifacts required by the spec-driven-workflow rule; drafted with Claude Code. |
| `README.md` | RudyG07 | Paired with Claude Code. |
| `FEEDBACK.md`, `PARTNERS.md` | RudyG07 | Paired with Claude Code. |
| `AI-USE.md` | RudyG07, Jnyandeep | First draft with Claude Code; Jnyandeep's Cursor rows added in Cursor. |

Adish7Pandya should amend their own rows if they used other tools.

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
