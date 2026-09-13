import "./lib/load-env.js";
/**
 * Runs the planner against a real chain and records what the registry did with each
 * proposal.
 *
 * The point of the exercise is the refusals. The model is given a genuine position and
 * a genuine parent grant, its reply is never filtered in TypeScript, and whatever it
 * asks for goes to `registerWithGrant`. Everything it proposes is logged with the
 * outcome, so the numbers in PARTNERS.md are a record of a run rather than an
 * assertion about one.
 *
 *   GEMINI_API_KEY=... npx tsx scripts/plan.ts
 */
import { readFileSync } from "node:fs";
import type { Address } from "viem";
import { loadDeployment, publicClientFor, walletClientFor } from "../broker/client.js";
import { grantStoreAbi } from "../broker/abi.js";
import { simulateGrant, tuple } from "../broker/grant.js";
import { registryAbi } from "../broker/abi.js";
import { readPosition } from "../agent/monitor.js";
import { plannerStats, proposeChildGrant, recordOutcome } from "../agent/planner.js";
import type { Grant } from "../agent/types.js";

const d = loadDeployment(process.env.ATTENUATE_DEPLOYMENT ?? "local");
const pub = publicClientFor(d) as never;
const key = (process.env.BROKER_KEY ??
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80") as `0x${string}`;
const wallet = walletClientFor(d, key);

if (!process.env.GEMINI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
  console.error("set GEMINI_API_KEY or ANTHROPIC_API_KEY");
  process.exit(1);
}

// Each parent is a different amount of headroom, which is the whole variable: the
// same risk asked of a tight parent is the case where a model is most likely to ask
// for more than exists.
const PARENTS = ["root", "risk", "exec", "probe"] as const;

async function grantOf(node: bigint): Promise<Grant> {
  return (await pub.readContract({
    address: d.store, abi: grantStoreAbi, functionName: "grantOf", args: [node],
  })) as Grant;
}

async function main() {
  const account = (await wallet.account.address) as Address;
  const position = await readPosition(d.executor as Address, d, pub);
  console.log(
    `position healthFactor=${position.healthFactor.toFixed(3)} ` +
    `debt=${position.debtUsd} collateral=${position.collateralUsd}\n`,
  );

  for (const name of PARENTS) {
    const raw = (d as unknown as Record<string, string>)[name];
    if (!raw) continue;
    const parentNode = BigInt(raw);
    const parent = await grantOf(parentNode);
    if (!parent.capabilities) continue;

    // A parent with no registry under it cannot be asked for a child at all.
    const registry = name === "risk" ? (d.riskRegistry as Address) : (d.registry as Address);
    const parentOfRegistry = (await pub.readContract({
      address: d.store, abi: grantStoreAbi, functionName: "nodeOf", args: [registry],
    })) as bigint;
    if (parentOfRegistry !== parentNode) continue;

    const p = await proposeChildGrant(position, parentNode, parent);
    const label = `${p.label}-${Math.random().toString(36).slice(2, 6)}`;
    const sim = await simulateGrant(pub, registry, account, {
      label, owner: account, resolver: account, grant: p.grant,
    });

    let txHash: `0x${string}` | undefined;
    if (sim.ok) {
      txHash = await wallet.writeContract({
        address: registry, abi: registryAbi, functionName: "registerWithGrant",
        args: [label, account, account, tuple(p.grant)],
      } as never);
      await pub.waitForTransactionReceipt({ hash: txHash });
    }

    await recordOutcome({ proposal: { ...p, label }, accepted: sim.ok, reason: sim.reason, txHash });
    console.log(
      `  under ${name.padEnd(6)} proposed ${p.label.padEnd(16)} ` +
      `${sim.ok ? "ACCEPTED" : `BLOCKED ${sim.reason} (${sim.field})`}`,
    );
    console.log(`         rationale: ${p.rationale}`);
  }

  const s = plannerStats();
  console.log(
    `\nproposed ${s.proposed} · accepted ${s.accepted} · blocked ${s.blocked} ` +
    `· reached execution ${s.reachedExecution}`,
  );
  if (s.blocked) console.log(`blocked by reason: ${JSON.stringify(s.byReason)}`);
}

main().catch((e) => { console.error(e?.shortMessage ?? e?.message ?? e); process.exit(1); });
