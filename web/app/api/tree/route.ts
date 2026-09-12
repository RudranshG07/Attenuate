import { NextResponse } from "next/server";
import { RANGE, abiOf, client, decodeCaps, deployment, events, usdc } from "../../lib/chain";

export const dynamic = "force-dynamic";

function human(expiry: bigint) {
  const s = Number(expiry) - Math.floor(Date.now() / 1000);
  if (s <= 0) return "expired";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export async function GET() {
  try {
    const d = deployment();
    const abi = abiOf("GrantStore");
    const c = client();

    // Every registry below the root is deployed at grant time, so the store's own
    // authorisations are the only complete list of where labels can be found.
    const [roots, grants, authorized] = await Promise.all([
      c.getLogs({ address: d.store, event: events.rootInit, ...RANGE }),
      c.getLogs({ address: d.store, event: events.granted, ...RANGE }),
      c.getLogs({ address: d.store, event: events.registryAuthorized, ...RANGE }),
    ]);

    const registries = [...new Set(authorized.map((l) => (l.args as any).registry as string))];
    const labels = new Map<string, string>();
    for (const r of registries) {
      for (const l of await c.getLogs({ address: r as `0x${string}`, event: events.named, ...RANGE })) {
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
      const [g, live] = await Promise.all([
        c.readContract({ address: d.store, abi, functionName: "grantOf", args: [BigInt(id)] }) as Promise<any>,
        c.readContract({ address: d.store, abi, functionName: "isLive", args: [BigInt(id)] }) as Promise<boolean>,
      ]);
      nodes.set(id, {
        id,
        label: labels.get(id) ?? null,
        parent: g.parent.toString(),
        capabilities: decodeCaps(g.capabilities),
        spendCap: usdc(g.spendCap),
        spendRemaining: usdc(g.spendRemaining),
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

    const ROOT_NAME = process.env.ROOT_NAME ?? d.name ?? "attenuate.eth";
    const name = (n: any, suffix: string) => {
      n.name = suffix;
      for (const c2 of n.children) name(c2, `${c2.label ?? c2.id.slice(0, 6)}.${suffix}`);
    };
    if (root) name(root, ROOT_NAME);

    return NextResponse.json({ connected: true, root });
  } catch (e) {
    return NextResponse.json(
      { connected: false, root: null, error: (e as Error).message },
      { status: 500 },
    );
  }
}
