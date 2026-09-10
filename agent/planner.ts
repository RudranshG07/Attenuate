import type { Grant, PositionHealth } from "./types.js";

export interface Proposal {
  parentNode: `0x${string}`;
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

export const PLANNER_SYSTEM_PROMPT = `You are the Attenuate grant planner.

Propose the narrowest child grant that addresses the current position risk. A proposal must be valid JSON with exactly these fields:
{
  "label": string,
  "grant": {
    "capabilities": string,
    "spendCap": string,
    "spendRemaining": string,
    "queryBudget": string,
    "queryRemaining": string,
    "expiry": string,
    "maxDepth": number,
    "readOnly": boolean,
    "revoked": false,
    "reclaimed": false,
    "parent": string,
    "parentEpochAtGrant": string,
    "epoch": string
  },
  "rationale": string
}

All bigint values are decimal strings. The child grant must attenuate every parent field: capabilities may only narrow, budgets and expiry may only decrease, maxDepth must be lower, and a read-only parent may only create a read-only child. Prefer short expiry, zero delegation depth, and the minimum capability and budget needed. Never invent capabilities outside the parent grant.`;

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
