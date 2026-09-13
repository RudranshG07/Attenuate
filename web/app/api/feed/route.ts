import { NextResponse } from "next/server";
import { RANGE, ago, client, decodeCaps, deployment, events, explorerTx, usdc } from "../../lib/chain";

export const dynamic = "force-dynamic";

interface Row {
  id: string;
  kind: string;
  name: string;
  detail: string;
  reason?: string;
  txHash: string;
  block: bigint;
  at: string;
}

export async function GET() {
  try {
    const d = deployment();
    const c = client();
    const registries = [d.registry, d.riskRegistry].filter(Boolean);

    const [roots, named, revoked, executed, reclaimed] = await Promise.all([
      c.getLogs({ address: d.store, event: events.rootInit, ...RANGE }),
      Promise.all(registries.map((r: `0x${string}`) =>
        c.getLogs({ address: r, event: events.named, ...RANGE }))).then((x) => x.flat()),
      c.getLogs({ address: d.store, event: events.revoked, ...RANGE }),
      c.getLogs({ address: d.executor, event: events.executed, ...RANGE }),
      c.getLogs({ address: d.store, event: events.reclaimed, ...RANGE }),
    ]);
    const blocked = (await Promise.all(registries.map((r: `0x${string}`) =>
      c.getLogs({ address: r, event: events.blocked, ...RANGE })))).flat();

    const names = new Map<string, string>();
    for (const l of named) names.set((l.args as any).tokenId.toString(), (l.args as any).label);

    const blocks = new Map<bigint, bigint>();
    const need = new Set<bigint>();
    for (const l of [...roots, ...named, ...revoked, ...executed, ...reclaimed, ...blocked]) need.add(l.blockNumber!);
    await Promise.all([...need].map(async (b) => {
      blocks.set(b, (await c.getBlock({ blockNumber: b })).timestamp);
    }));

    const at = (b: bigint) => ago(blocks.get(b) ?? 0n);
    const rows: Row[] = [];

    for (const l of roots) {
      const a = l.args as any;
      rows.push({
        id: l.transactionHash! + l.logIndex, kind: "mandate", name: "root",
        detail: `root mandate signed${
          d.mandateSigner === "device" ? " on device" : d.mandateSigner === "software" ? " in software" : ""
        }, cap ${usdc(a.grant.spendCap)} USDC, depth ${a.grant.maxDepth}`,
        txHash: l.transactionHash!, block: l.blockNumber!, at: at(l.blockNumber!),
      });
    }
    for (const l of named) {
      const a = l.args as any;
      const caps = decodeCaps(a.grant.capabilities);
      rows.push({
        id: l.transactionHash! + l.logIndex, kind: "granted", name: a.label,
        detail: `${caps.join(", ")} · ${usdc(a.grant.spendCap)} USDC${a.grant.readOnly ? " · read-only" : ""}`,
        txHash: l.transactionHash!, block: l.blockNumber!, at: at(l.blockNumber!),
      });
    }
    for (const l of blocked) {
      const a = l.args as any;
      rows.push({
        id: l.transactionHash! + l.logIndex, kind: "blocked", name: a.label,
        detail: `proposed ${decodeCaps(a.proposed.capabilities).join(", ") || "no capabilities"} · ${usdc(a.proposed.spendCap)} USDC`,
        reason: a.reason,
        txHash: l.transactionHash!, block: l.blockNumber!, at: at(l.blockNumber!),
      });
    }
    for (const l of revoked) {
      const a = l.args as any;
      rows.push({
        id: l.transactionHash! + l.logIndex, kind: "revoked",
        name: names.get(a.node.toString()) ?? "root",
        detail: `epoch bumped to ${a.epoch}, whole subtree dead in this block`,
        txHash: l.transactionHash!, block: l.blockNumber!, at: at(l.blockNumber!),
      });
    }
    for (const l of executed) {
      const a = l.args as any;
      rows.push({
        id: l.transactionHash! + l.logIndex, kind: "executed",
        name: names.get(a.node.toString()) ?? "agent",
        detail: `spent ${usdc(a.spend)} USDC via capability ${a.capBit}`,
        txHash: l.transactionHash!, block: l.blockNumber!, at: at(l.blockNumber!),
      });
    }
    for (const l of reclaimed) {
      const a = l.args as any;
      rows.push({
        id: l.transactionHash! + l.logIndex, kind: "reclaimed",
        name: names.get(a.node.toString()) ?? "agent",
        detail: `${usdc(a.spend)} USDC returned to nearest live ancestor`,
        txHash: l.transactionHash!, block: l.blockNumber!, at: at(l.blockNumber!),
      });
    }

    rows.sort((a, b) => Number(b.block - a.block));
    return NextResponse.json({
      connected: true,
      items: rows.map(({ block, ...r }) => ({ ...r, txUrl: explorerTx(r.txHash) })),
    });
  } catch {
    return NextResponse.json({ connected: false, items: [] });
  }
}
