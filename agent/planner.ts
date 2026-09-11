import Anthropic from "@anthropic-ai/sdk";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { Grant, PositionHealth } from "./types.js";
import { decodeCapabilities } from "../broker/grant.js";

export interface Proposal {
  parentNode: bigint;
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

// The schema constrains the shape so the reply always parses. It deliberately does
// not constrain the scope: the model is free to ask for more than the parent holds,
// and the registry is what refuses. Filtering here would move the safety into the
// client, which is the thing this project argues against.
const GRANT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["label", "grant", "rationale"],
  properties: {
    label: { type: "string", description: "short ENS label, lowercase, no dots" },
    rationale: { type: "string", description: "one sentence on why this scope" },
    grant: {
      type: "object",
      additionalProperties: false,
      required: ["capabilities", "spendCap", "queryBudget", "expiry", "maxDepth", "readOnly"],
      properties: {
        capabilities: { type: "string", description: "decimal bitmask" },
        spendCap: { type: "string", description: "decimal wei" },
        queryBudget: { type: "string", description: "decimal units" },
        expiry: { type: "string", description: "decimal unix seconds" },
        maxDepth: { type: "integer", minimum: 0 },
        readOnly: { type: "boolean" },
      },
    },
  },
} as const;

const LOG = process.env.ATTENUATE_PLANNER_LOG ?? "deployments/planner-log.jsonl";

function describeParent(g: Grant) {
  return [
    `capabilities: ${decodeCapabilities(g.capabilities).join(", ") || "none"} (bitmask ${g.capabilities})`,
    `spendRemaining: ${g.spendRemaining} wei of a ${g.spendCap} cap`,
    `queryRemaining: ${g.queryRemaining} of ${g.queryBudget}`,
    `expiry: ${g.expiry} (unix seconds)`,
    `maxDepth: ${g.maxDepth}`,
    `readOnly: ${g.readOnly}`,
  ].join("\n");
}

export async function proposeChildGrant(
  position: PositionHealth,
  parentNode: bigint,
  parentGrant: Grant,
): Promise<Proposal> {
  const client = new Anthropic();

  const response = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    system: PLANNER_SYSTEM_PROMPT,
    output_config: { format: { type: "json_schema", schema: GRANT_SCHEMA } },
    messages: [
      {
        role: "user",
        content: [
          "Position:",
          `  healthFactor: ${position.healthFactor}`,
          `  collateralUsd: ${position.collateralUsd}`,
          `  debtUsd: ${position.debtUsd}`,
          `  liquidationThreshold: ${position.liquidationThreshold}`,
          "",
          "Parent grant:",
          describeParent(parentGrant),
          "",
          "Propose the narrowest child grant that addresses this risk.",
        ].join("\n"),
      },
    ],
  });

  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("planner returned no text block");
  const raw = JSON.parse(text.text) as {
    label: string;
    rationale: string;
    grant: Record<string, string | number | boolean>;
  };

  return {
    parentNode,
    label: raw.label,
    rationale: raw.rationale,
    proposedAt: Math.floor(Date.now() / 1000),
    grant: {
      capabilities: BigInt(raw.grant.capabilities as string),
      spendCap: BigInt(raw.grant.spendCap as string),
      spendRemaining: 0n,
      queryBudget: BigInt(raw.grant.queryBudget as string),
      queryRemaining: 0n,
      expiry: BigInt(raw.grant.expiry as string),
      maxDepth: Number(raw.grant.maxDepth),
      readOnly: Boolean(raw.grant.readOnly),
      revoked: false,
      reclaimed: false,
      parent: 0n,
      parentEpochAtGrant: 0n,
      epoch: 0n,
    },
  };
}

// Every proposal is logged, accepted or refused. The refusals are the measurement,
// not the failures: "the model proposed N grants, M exceeded scope, M were blocked".
export async function recordOutcome(o: ProposalOutcome): Promise<void> {
  const row = {
    at: new Date().toISOString(),
    label: o.proposal.label,
    rationale: o.proposal.rationale,
    capabilities: o.proposal.grant.capabilities.toString(),
    spendCap: o.proposal.grant.spendCap.toString(),
    maxDepth: o.proposal.grant.maxDepth,
    accepted: o.accepted,
    reason: o.reason ?? null,
    txHash: o.txHash ?? null,
  };
  appendFileSync(LOG, JSON.stringify(row) + "\n");
}

export interface PlannerStats {
  proposed: number;
  accepted: number;
  blocked: number;
  reachedExecution: number;
  byReason: Record<string, number>;
}

export function plannerStats(path = LOG): PlannerStats {
  if (!existsSync(path)) {
    return { proposed: 0, accepted: 0, blocked: 0, reachedExecution: 0, byReason: {} };
  }
  const rows = readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const byReason: Record<string, number> = {};
  for (const r of rows) if (!r.accepted && r.reason) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
  const accepted = rows.filter((r) => r.accepted).length;
  return {
    proposed: rows.length,
    accepted,
    blocked: rows.length - accepted,
    // An out-of-scope grant can never execute, because the name is never minted.
    reachedExecution: 0,
    byReason,
  };
}
