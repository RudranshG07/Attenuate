import { parseAbiItem, type Address, type PublicClient } from "viem";
import { grantStoreAbi } from "../broker/abi.js";
import { loadDeployment, publicClientFor, type Deployment } from "../broker/client.js";
import { decodeCapabilities } from "../broker/grant.js";

const GRANT_TUPLE =
  "(uint256 capabilities,uint256 spendCap,uint256 spendRemaining,uint256 queryBudget,uint256 queryRemaining,uint64 expiry,uint16 maxDepth,bool readOnly,bool revoked,bool reclaimed,uint256 parent,uint64 parentEpochAtGrant,uint64 epoch)";

const rootEvent = parseAbiItem(`event RootInitialised(uint256 indexed node, ${GRANT_TUPLE} grant)`);
const namedEvent = parseAbiItem(
  `event Granted(uint256 indexed tokenId, string label, address owner, ${GRANT_TUPLE} grant)`,
);

const RANGE = { fromBlock: 0n, toBlock: "latest" } as const;

export interface Node {
  node: bigint;
  name: string;
  label: string | null;
  parent: bigint;
  registry: Address | null;
  live: boolean;
  capabilities: string[];
  spendCap: bigint;
  spendRemaining: bigint;
  queryBudget: bigint;
  queryRemaining: bigint;
  expiry: bigint;
  maxDepth: number;
  readOnly: boolean;
  revoked: boolean;
  depth: number;
  agent: Address;
}

export interface Snapshot {
  deployment: Deployment;
  client: PublicClient;
  rootName: string;
  byName: Map<string, Node>;
  byNode: Map<string, Node>;
}

function registries(d: Deployment): Address[] {
  return [d.registry, d.riskRegistry].filter(Boolean) as Address[];
}

export async function snapshot(name = process.env.ATTENUATE_DEPLOYMENT ?? "local"): Promise<Snapshot> {
  const d = loadDeployment(name);
  const c = publicClientFor(d) as unknown as PublicClient;
  const rootName = process.env.ATTENUATE_ROOT ?? "attenuate.eth";

  const [roots, ...named] = await Promise.all([
    c.getLogs({ address: d.store, event: rootEvent, ...RANGE }),
    ...registries(d).map((r) => c.getLogs({ address: r, event: namedEvent, ...RANGE })),
  ]);

  const labels = new Map<string, string>();
  for (const l of named.flat()) {
    const a = l.args as { tokenId: bigint; label: string };
    labels.set(a.tokenId.toString(), a.label);
  }

  // Which registry governs which node, read straight off the store.
  const governs = new Map<string, Address>();
  for (const r of registries(d)) {
    const n = (await c.readContract({
      address: d.store, abi: grantStoreAbi, functionName: "nodeOf", args: [r],
    })) as bigint;
    if (n !== 0n) governs.set(n.toString(), r);
  }

  const ids = new Set<string>();
  for (const l of roots) ids.add((l.args as { node: bigint }).node.toString());
  for (const k of labels.keys()) ids.add(k);

  const byNode = new Map<string, Node>();
  for (const id of ids) {
    const g = (await c.readContract({
      address: d.store, abi: grantStoreAbi, functionName: "grantOf", args: [BigInt(id)],
    })) as any;
    if (g.epoch === 0n) continue;
    const [live, agent] = await Promise.all([
      c.readContract({ address: d.store, abi: grantStoreAbi, functionName: "isLive", args: [BigInt(id)] }) as Promise<boolean>,
      c.readContract({ address: d.store, abi: grantStoreAbi, functionName: "agentOf", args: [BigInt(id)] }) as Promise<Address>,
    ]);
    byNode.set(id, {
      node: BigInt(id),
      name: "",
      label: labels.get(id) ?? null,
      parent: g.parent,
      registry: governs.get(id) ?? null,
      live,
      capabilities: decodeCapabilities(g.capabilities),
      spendCap: g.spendCap,
      spendRemaining: g.spendRemaining,
      queryBudget: g.queryBudget,
      queryRemaining: g.queryRemaining,
      expiry: g.expiry,
      maxDepth: g.maxDepth,
      readOnly: g.readOnly,
      revoked: g.revoked,
      depth: 0,
      agent,
    });
  }

  // Names are built by walking down from the root, so a name is only ever
  // the concatenation of labels along a real parent chain.
  const byName = new Map<string, Node>();
  const children = (p: bigint) => [...byNode.values()].filter((n) => n.parent === p);
  const walk = (n: Node, suffix: string, depth: number) => {
    n.name = suffix;
    n.depth = depth;
    byName.set(suffix, n);
    for (const c2 of children(n.node)) walk(c2, `${c2.label ?? c2.node.toString().slice(0, 6)}.${suffix}`, depth + 1);
  };
  const root = [...byNode.values()].find((n) => n.parent === 0n);
  if (root) walk(root, rootName, 0);

  return { deployment: d, client: c, rootName, byName, byNode };
}

export function requireNode(s: Snapshot, name: string): Node {
  const n = s.byName.get(name.trim());
  if (!n) {
    const known = [...s.byName.keys()].join(", ") || "none";
    throw new Error(`unknown name "${name}". known names: ${known}`);
  }
  return n;
}
