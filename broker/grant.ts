import { encodeFunctionData, type Address, type PublicClient } from "viem";
import { grantStoreAbi, registryAbi } from "./abi.js";
import type { Grant } from "./types.js";

// Legality is decided by AttenuatedSubregistry and GrantStore, never here.
// simulateGrant predicts a refusal for UX; the chain is always the authority.

export interface GrantArgs {
  label: string;
  owner: Address;
  resolver: Address;
  grant: Grant;
}

const ZERO = "0x0000000000000000000000000000000000000000" as const;

export function tuple(g: Grant) {
  return [
    g.capabilities, g.spendCap, g.spendRemaining, g.queryBudget, g.queryRemaining,
    g.expiry, g.maxDepth, g.readOnly, g.revoked, g.reclaimed,
    g.parent, g.parentEpochAtGrant, g.epoch,
  ] as const;
}

export function newGrant(p: Partial<Grant> & Pick<Grant, "capabilities" | "spendCap" | "expiry">): Grant {
  return {
    spendRemaining: 0n, queryBudget: 0n, queryRemaining: 0n,
    maxDepth: 0, readOnly: false, revoked: false, reclaimed: false,
    parent: 0n, parentEpochAtGrant: 0n, epoch: 0n,
    ...p,
  };
}

export function encodeRegisterWithGrant(a: GrantArgs) {
  return encodeFunctionData({
    abi: registryAbi,
    functionName: "registerWithGrant",
    args: [a.label, a.owner, a.resolver, tuple(a.grant)],
  });
}

export function encodeRegisterOrLog(a: GrantArgs) {
  return encodeFunctionData({
    abi: registryAbi,
    functionName: "registerOrLog",
    args: [a.label, a.owner, a.resolver, tuple(a.grant)],
  });
}

export interface SimulationResult {
  ok: boolean;
  reason?: string;
  field?: string;
}

// Which grant field each refusal points at, so a caller knows what to narrow.
const FIELD: Record<string, string> = {
  SCOPE_WIDENED: "capabilities",
  CAP_EXCEEDS_UNALLOCATED: "spendCap",
  BUDGET_EXCEEDS_UNALLOCATED: "queryBudget",
  EXPIRY_EXTENDED: "expiry",
  DEPTH_EXCEEDED: "maxDepth",
  READONLY_ESCALATION: "readOnly",
  PARENT_DEAD: "parent",
  NOT_GRANTOR: "caller",
  EXISTS: "label",
  // EAC's own error, raised before any attenuation check runs.
  EACUnauthorizedAccountRoles: "caller",
};

function reasonFrom(err: unknown): string {
  const s = JSON.stringify(err instanceof Error ? err.message : err);
  for (const r of Object.keys(FIELD)) if (s.includes(r)) return r;
  const m = s.match(/reverted with(?: the following)? reason:?\s*\\?"?([A-Z_]+)/);
  return m?.[1] ?? "REVERTED";
}

export async function simulateGrant(
  client: PublicClient,
  registry: Address,
  caller: Address,
  a: GrantArgs,
): Promise<SimulationResult> {
  try {
    await client.simulateContract({
      address: registry,
      abi: registryAbi,
      functionName: "registerWithGrant",
      args: [a.label, a.owner, a.resolver, tuple(a.grant)],
      account: caller,
    });
    return { ok: true };
  } catch (e) {
    const reason = reasonFrom(e);
    return { ok: false, reason, field: FIELD[reason] };
  }
}

export interface Scope {
  live: boolean;
  capabilities: bigint;
  spendCap: bigint;
  spendRemaining: bigint;
  queryRemaining: bigint;
  expiry: bigint;
  maxDepth: number;
  readOnly: boolean;
  revoked: boolean;
  depth: number;
  agent: Address;
}

export async function checkScope(
  client: PublicClient,
  store: Address,
  node: bigint,
): Promise<Scope> {
  const base = { address: store, abi: grantStoreAbi } as const;
  const [g, live, depth, agent] = await Promise.all([
    client.readContract({ ...base, functionName: "grantOf", args: [node] }) as Promise<any>,
    client.readContract({ ...base, functionName: "isLive", args: [node] }) as Promise<boolean>,
    client.readContract({ ...base, functionName: "depthOf", args: [node] }) as Promise<bigint>,
    client.readContract({ ...base, functionName: "agentOf", args: [node] }) as Promise<Address>,
  ]);
  return {
    live,
    capabilities: g.capabilities,
    spendCap: g.spendCap,
    spendRemaining: g.spendRemaining,
    queryRemaining: g.queryRemaining,
    expiry: g.expiry,
    maxDepth: Number(g.maxDepth),
    readOnly: g.readOnly,
    revoked: g.revoked,
    depth: Number(depth),
    agent: agent === ZERO ? ZERO : agent,
  };
}

export const CAPABILITIES = [
  "swap.uniswap", "lend.aave.supply", "lend.aave.repay", "lend.aave.withdraw",
  "erc20.approve", "transfer.native", "data.graph.read", "delegate",
] as const;

export function decodeCapabilities(mask: bigint): string[] {
  return CAPABILITIES.filter((_, i) => (mask >> BigInt(i)) & 1n);
}

/**
 * Accept capabilities the way they are read back: as names. A caller that already has
 * a bitmask can still pass one, but nobody should have to know our bit positions to
 * use the MCP server, and `check_scope` reports names — so the two have to meet.
 */
export function encodeCapabilities(input: string | readonly string[]): bigint {
  if (typeof input === "string" && /^(0x)?[0-9]+$/.test(input.trim())) {
    return BigInt(input.trim());
  }
  const names = typeof input === "string" ? input.split(/[,\s]+/).filter(Boolean) : input;
  let mask = 0n;
  for (const n of names) {
    const i = CAPABILITIES.indexOf(n.trim() as (typeof CAPABILITIES)[number]);
    if (i < 0) {
      throw new Error(`unknown capability "${n}". Known: ${CAPABILITIES.join(", ")}`);
    }
    mask |= 1n << BigInt(i);
  }
  return mask;
}
