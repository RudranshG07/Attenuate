import type { PositionHealth } from "./types.js";

export type Decision =
  | { kind: "none" }
  | { kind: "act"; capBit: number; amount: bigint }
  | { kind: "delegate"; label: string }
  | { kind: "escalate"; summary: string };

export async function decide(h: PositionHealth): Promise<Decision> {
  throw new Error("todo");
}

// Spawns a process with its own key, not an in-process call.
export async function spawnSubAgent(node: `0x${string}`, label: string): Promise<void> {
  throw new Error("todo");
}
