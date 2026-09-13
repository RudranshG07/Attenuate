import { encodeFunctionData, parseUnits, type Address } from "viem";
import { capabilityRegistryAbi, executorAbi, grantStoreAbi, registryAbi } from "../broker/abi.js";
import { walletClientFor } from "../broker/client.js";
import { newGrant, simulateGrant, tuple } from "../broker/grant.js";
import { Cap, type Grant } from "../broker/types.js";
import { deviceAvailable, requestApproval } from "../broker/keyring.js";
import { readPosition } from "../agent/monitor.js";
import { requireNode, snapshot, type Node } from "./tree.js";

export interface GrantInput {
  capabilities: string;
  spendCap: string;
  queryBudget: string;
  expiry: number;
  maxDepth: number;
  readOnly: boolean;
}

function toGrant(g: GrantInput): Grant {
  return newGrant({
    capabilities: BigInt(g.capabilities),
    spendCap: BigInt(g.spendCap),
    queryBudget: BigInt(g.queryBudget),
    expiry: BigInt(g.expiry),
    maxDepth: g.maxDepth,
    readOnly: g.readOnly,
  });
}

const asUsdc = (v: bigint) => `${Number(v / 10n ** 16n) / 100}`;

function describe(n: Node) {
  return {
    name: n.name,
    live: n.live,
    revoked: n.revoked,
    capabilities: n.capabilities,
    spendCap: asUsdc(n.spendCap),
    spendRemaining: asUsdc(n.spendRemaining),
    queryBudget: n.queryBudget.toString(),
    queryRemaining: n.queryRemaining.toString(),
    expiry: Number(n.expiry),
    expiresInSeconds: Math.max(0, Number(n.expiry) - Math.floor(Date.now() / 1000)),
    maxDepth: n.maxDepth,
    readOnly: n.readOnly,
    depth: n.depth,
    canDelegate: n.capabilities.includes("delegate") && n.maxDepth > 0,
    agent: n.agent,
    node: n.node.toString(),
  };
}

function brokerKey(): `0x${string}` {
  const k = process.env.ATTENUATE_PRIVATE_KEY;
  if (!k) throw new Error("ATTENUATE_PRIVATE_KEY is not set, so write tools are unavailable");
  return k as `0x${string}`;
}

export async function simulate_grant(a: { parent: string; grant: GrantInput }) {
  const s = await snapshot();
  const p = requireNode(s, a.parent);
  if (!p.registry) {
    return { ok: false, reason: "NO_REGISTRY", detail: `${p.name} has no subregistry, so it cannot have children` };
  }
  const r = await simulateGrant(s.client, p.registry, p.agent, {
    label: "simulated",
    owner: p.agent,
    resolver: p.agent,
    grant: toGrant(a.grant),
  });
  return r.ok
    ? { ok: true, parent: p.name, parentRemaining: asUsdc(p.spendRemaining) }
    : { ok: false, reason: r.reason, field: r.field, parent: p.name, parentRemaining: asUsdc(p.spendRemaining) };
}

export async function check_scope(a: { name: string }) {
  const s = await snapshot();
  return describe(requireNode(s, a.name));
}

export async function get_delegation_tree(a: { root: string }) {
  const s = await snapshot();
  const r = requireNode(s, a.root);
  const kids = (p: bigint): any[] =>
    [...s.byNode.values()]
      .filter((n) => n.parent === p)
      .map((n) => ({ ...describe(n), children: kids(n.node) }));
  return { ...describe(r), children: kids(r.node) };
}

// A grant can be refused for two different kinds of reason, and only one of them is
// a question for a human. Running out of unallocated cap or budget is a spending
// decision the operator can make on the device. Asking for a capability the parent
// never held, or an expiry past its own, is structural: no signature widens it,
// because the registry would refuse the mint either way.
const ESCALATABLE = new Set(["CAP_EXCEEDS_UNALLOCATED", "BUDGET_EXCEEDS_UNALLOCATED"]);

async function escalate(
  a: { parent: string; label: string; grant: GrantInput },
  parent: Node,
  refusal: { ok: boolean; reason?: string; field?: string } & Record<string, unknown>,
) {
  if (!refusal.reason || !ESCALATABLE.has(refusal.reason) || !deviceAvailable()) {
    return refusal;
  }

  const needed = refusal.reason === "CAP_EXCEEDS_UNALLOCATED"
    ? parseUnits(String(a.grant.spendCap ?? 0), 18)
    : BigInt(a.grant.queryBudget ?? 0);
  const allowed = refusal.reason === "CAP_EXCEEDS_UNALLOCATED"
    ? parent.spendRemaining
    : parent.queryRemaining;

  const approved = await requestApproval({
    name: `${a.label}.${parent.name}`,
    reason: refusal.reason,
    needed,
    allowed,
  });

  // Approval is a human saying the tree should be widened, not a bypass: the parent
  // still holds what it holds, so the mint stays refused until someone re-grants it
  // headroom from above.
  return { ...refusal, escalated: true, approvedOnDevice: approved };
}

export async function grant_capability(a: {
  parent: string; label: string; owner: string; grant: GrantInput;
}) {
  const s = await snapshot();
  const p = requireNode(s, a.parent);
  if (!p.registry) throw new Error(`${p.name} has no subregistry`);

  const pre = await simulate_grant({ parent: a.parent, grant: a.grant });
  if (!pre.ok) return escalate(a, p, pre);

  const w = walletClientFor(s.deployment, brokerKey());
  const hash = await w.writeContract({
    address: p.registry,
    abi: registryAbi,
    functionName: "registerWithGrant",
    args: [a.label, a.owner as Address, a.owner as Address, tuple(toGrant(a.grant))],
  });
  await s.client.waitForTransactionReceipt({ hash });
  return { ok: true, name: `${a.label}.${p.name}`, txHash: hash };
}

export async function revoke_agent(a: { name: string }) {
  const s = await snapshot();
  const n = requireNode(s, a.name);
  const parent = s.byNode.get(n.parent.toString());
  const registry = parent?.registry ?? s.deployment.registry;

  const w = walletClientFor(s.deployment, brokerKey());
  const hash = await w.writeContract({
    address: s.deployment.store,
    abi: (await import("../broker/abi.js")).grantStoreAbi,
    functionName: "revoke",
    args: [n.node],
  });
  await s.client.waitForTransactionReceipt({ hash });

  const after = await snapshot();
  const dead = [...after.byNode.values()].filter((x) => !x.live).length;
  return { ok: true, name: n.name, txHash: hash, nodesNowDead: dead, registry };
}

export async function query_position(a: { name: string; protocol: string; account: string }) {
  const s = await snapshot();
  const n = requireNode(s, a.name);
  if (!n.capabilities.includes("data.graph.read")) {
    return { ok: false, reason: "CAP_MISSING", detail: `${n.name} does not hold data.graph.read` };
  }
  if (n.queryRemaining <= 0n) {
    return { ok: false, reason: "OVER_QUERY_BUDGET", detail: `${n.name} has no query budget left` };
  }

  const account = (a.account || s.deployment.executor) as Address;
  const pos = await readPosition(account, s.deployment, s.client);

  let txHash: `0x${string}` | undefined;
  let queryRemaining = n.queryRemaining;
  const key = process.env.ATTENUATE_PRIVATE_KEY ?? process.env.BROKER_KEY;
  if (key) {
    const spec = (await s.client.readContract({
      address: s.deployment.caps,
      abi: capabilityRegistryAbi,
      functionName: "caps",
      args: [Cap.DATA_GRAPH_READ],
    })) as { target: Address; selector: `0x${string}`; enabled: boolean };
    if (!spec.enabled) throw new Error("CAP_DISABLED: data.graph.read is not configured");

    const callData = encodeFunctionData({
      abi: [{ type: "function", name: "healthFactor", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" }],
      functionName: "healthFactor",
      args: [account],
    });
    const w = walletClientFor(s.deployment, key as `0x${string}`);
    txHash = await w.writeContract({
      address: s.deployment.executor,
      abi: executorAbi,
      functionName: "execute",
      args: [n.node, Cap.DATA_GRAPH_READ, spec.target, 0n, callData],
    });
    await s.client.waitForTransactionReceipt({ hash: txHash });
    const after = (await s.client.readContract({
      address: s.deployment.store, abi: grantStoreAbi, functionName: "grantOf", args: [n.node],
    })) as { queryRemaining: bigint };
    queryRemaining = after.queryRemaining;
  }

  let subgraph: unknown;
  const url = process.env.GRAPH_SUBGRAPH_URL;
  if (url) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `{ stats(id: "global") { agentsGranted executions totalSpent } agents(first: 10) { id label spendRemaining queryRemaining revoked } }`,
      }),
    });
    if (res.ok) subgraph = await res.json();
  }

  return {
    ok: true,
    protocol: a.protocol,
    account,
    healthFactor: Number.isFinite(pos.healthFactor) ? pos.healthFactor : "inf",
    collateralUsd: pos.collateralUsd.toString(),
    debtUsd: pos.debtUsd.toString(),
    liquidationThreshold: pos.liquidationThreshold,
    blockNumber: pos.blockNumber.toString(),
    paid: Boolean(txHash),
    txHash,
    queryRemaining: queryRemaining.toString(),
    subgraph: subgraph ?? null,
  };
}
