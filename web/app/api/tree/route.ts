import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { createPublicClient, http, parseAbiItem } from "viem";
import { foundry } from "viem/chains";

export const dynamic = "force-dynamic";

const CAPS = [
  "swap.uniswap", "lend.aave.supply", "lend.aave.repay", "lend.aave.withdraw",
  "erc20.approve", "transfer.native", "data.graph.read", "delegate",
];

const decode = (m: bigint) => CAPS.filter((_, i) => (m >> BigInt(i)) & 1n);

function human(expiry: bigint) {
  const s = Number(expiry) - Math.floor(Date.now() / 1000);
  if (s <= 0) return "expired";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const GRANT_TUPLE =
  "(uint256 capabilities,uint256 spendCap,uint256 spendRemaining,uint256 queryBudget,uint256 queryRemaining,uint64 expiry,uint16 maxDepth,bool readOnly,bool revoked,bool reclaimed,uint256 parent,uint64 parentEpochAtGrant,uint64 epoch)";

const rootEvent = parseAbiItem(`event RootInitialised(uint256 indexed node, ${GRANT_TUPLE} grant)`);
const grantEvent = parseAbiItem(`event Granted(uint256 indexed parent, uint256 indexed child, ${GRANT_TUPLE} grant)`);
const namedEvent = parseAbiItem(`event Granted(uint256 indexed tokenId, string label, address owner, ${GRANT_TUPLE} grant)`);

export async function GET() {
  try {
    const cwd = process.cwd().replace(/\/web$/, "");
    const d = JSON.parse(readFileSync(`${cwd}/deployments/local.json`, "utf8"));
    const abi = JSON.parse(
      readFileSync(`${cwd}/contracts/out/GrantStore.sol/GrantStore.json`, "utf8"),
    ).abi;

    const client = createPublicClient({
      chain: foundry,
      transport: http(process.env.RPC_URL ?? "http://127.0.0.1:8545"),
    });

    const range = { fromBlock: 0n, toBlock: "latest" } as const;
    const [roots, grants] = await Promise.all([
      client.getLogs({ address: d.store, event: rootEvent, ...range }),
      client.getLogs({ address: d.store, event: grantEvent, ...range }),
    ]);

    // Labels live on the registry side; token ids are the join key.
    const registries = [d.registry, d.riskRegistry].filter(Boolean);
    const labels = new Map<string, string>();
    for (const r of registries) {
      const named = await client.getLogs({ address: r, event: namedEvent, ...range });
      for (const l of named) {
        const a = l.args as any;
        labels.set(a.tokenId.toString(), a.label);
      }
    }

    const ids = new Set<string>();
    for (const l of roots) ids.add((l.args as any).node.toString());
    for (const l of grants) ids.add((l.args as any).child.toString());
    if (ids.size === 0) return NextResponse.json({ connected: true, root: null });

    const nodes = new Map<string, any>();
    for (const id of ids) {
      const g: any = await client.readContract({
        address: d.store, abi, functionName: "grantOf", args: [BigInt(id)],
      });
      const live = (await client.readContract({
        address: d.store, abi, functionName: "isLive", args: [BigInt(id)],
      })) as boolean;

      nodes.set(id, {
        id,
        label: labels.get(id) ?? null,
        parent: g.parent.toString(),
        capabilities: decode(g.capabilities),
        spendCap: Number(g.spendCap / 10n ** 16n) / 100,
        spendRemaining: Number(g.spendRemaining / 10n ** 16n) / 100,
        queryRemaining: Number(g.queryRemaining),
        expiresIn: human(g.expiry),
        maxDepth: g.maxDepth,
        readOnly: g.readOnly,
        state: g.revoked || !live ? "dead" : "live",
        children: [],
      });
    }

    let root: any = null;
    for (const n of nodes.values()) {
      const p = nodes.get(n.parent);
      if (p) p.children.push(n);
      else root = n;
    }

    // Build full ENS names by walking down from the root.
    const ROOT_NAME = process.env.ROOT_NAME ?? "attenuate.eth";
    const name = (n: any, suffix: string) => {
      n.name = suffix;
      for (const c of n.children) name(c, `${c.label ?? c.id.slice(0, 6)}.${suffix}`);
    };
    if (root) name(root, ROOT_NAME);

    return NextResponse.json({ connected: true, root });
  } catch {
    return NextResponse.json({ connected: false, root: null });
  }
}
