import type { PositionHealth } from "./monitor.js";
import type { Grant } from "../broker/types.js";
import { decodeCapabilities } from "../broker/grant.js";

export type Decision =
  | { kind: "none"; why: string }
  | { kind: "act"; capBit: number; amount: bigint; why: string }
  | { kind: "delegate"; label: string; readOnly: boolean; why: string }
  | { kind: "escalate"; why: string };

// Bands, not a single threshold. The point is that each band picks the narrowest
// response available, and anything the grant cannot cover goes to the human.
export const SAFE = 1.5;
export const WATCH = 1.2;

export const CAP_REPAY = 2;

/** Repay enough to bring the position back to the safe band, capped by the grant. */
export function repayToSafe(h: PositionHealth): bigint {
  if (h.debtUsd === 0n) return 0n;
  const target = (h.collateralUsd * 100n) / BigInt(Math.round(SAFE * 100));
  return h.debtUsd > target ? h.debtUsd - target : 0n;
}

export function decide(h: PositionHealth, grant: Grant): Decision {
  if (h.stale) {
    return { kind: "none", why: "reading came from a reorged block, waiting for the next irreversible one" };
  }
  if (h.debtUsd === 0n) return { kind: "none", why: "no debt to defend" };
  if (h.healthFactor > SAFE) {
    return { kind: "none", why: `health ${h.healthFactor.toFixed(2)} is above ${SAFE}` };
  }

  const caps = decodeCapabilities(grant.capabilities);
  const needed = repayToSafe(h);

  if (h.healthFactor > WATCH) {
    // Approaching, not urgent. Buy information with a read-only, metered child
    // rather than spending, and only if this grant may delegate at all.
    if (caps.includes("delegate") && grant.maxDepth > 0 && grant.queryRemaining > 0n) {
      return { kind: "delegate", label: "risk", readOnly: true,
        why: `health ${h.healthFactor.toFixed(2)} approaching ${SAFE}, delegating a read-only look` };
    }
    return { kind: "none", why: `health ${h.healthFactor.toFixed(2)} approaching but no delegation budget` };
  }

  // Critical. Act directly if this grant can, otherwise hand the narrowest
  // possible spend to a short-lived child, otherwise ask the human.
  if (caps.includes("lend.aave.repay") && !grant.readOnly && needed <= grant.spendRemaining) {
    return { kind: "act", capBit: CAP_REPAY, amount: needed,
      why: `health ${h.healthFactor.toFixed(2)} critical, repaying ${needed} within budget` };
  }

  if (caps.includes("delegate") && grant.maxDepth > 0 && needed <= grant.spendRemaining) {
    return { kind: "delegate", label: "exec", readOnly: false,
      why: `health ${h.healthFactor.toFixed(2)} critical, delegating one repay of ${needed}` };
  }

  return { kind: "escalate",
    why: needed > grant.spendRemaining
      ? `health ${h.healthFactor.toFixed(2)} critical and ${needed} exceeds the ${grant.spendRemaining} this mandate allows`
      : `health ${h.healthFactor.toFixed(2)} critical and this grant holds no capability that can act` };
}

// Sub-agents are separate OS processes with their own keys resolving to their own
// names. A function call with a name attached inherits the parent's authority and
// makes the whole model theatre.
export async function spawnSubAgent(name: string, node: bigint): Promise<void> {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [process.argv[1] ?? "", "--as", name, "--node", node.toString()], {
    stdio: "inherit",
    env: { ...process.env, ATTENUATE_AGENT_NAME: name, ATTENUATE_AGENT_NODE: node.toString() },
    detached: false,
  });
  await new Promise<void>((res, rej) => {
    child.on("exit", (c) => (c === 0 ? res() : rej(new Error(`${name} exited ${c}`))));
    child.on("error", rej);
  });
}
