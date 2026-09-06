import type { Grant, PositionHealth } from "./types.js";

export interface Proposal {
  label: string;
  grant: Grant;
  rationale: string;
  proposedAt: number;
}

export interface ProposalOutcome {
  proposal: Proposal;
  accepted: boolean;
  reason?: string;
  txHash?: `0x${string}`;
}

export async function proposeChildGrant(
  position: PositionHealth,
  parentNode: `0x${string}`,
  parentGrant: Grant,
): Promise<Proposal> {
  throw new Error("todo");
}

export async function recordOutcome(o: ProposalOutcome): Promise<void> {
  throw new Error("todo");
}
