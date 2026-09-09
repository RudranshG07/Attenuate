import { NextResponse } from "next/server";
import { parseUnits } from "viem";
import { abiOf, broker, client, deployment } from "../../lib/chain";

export const dynamic = "force-dynamic";

const registryAbi = abiOf("AttenuatedSubregistry");
const storeAbi = abiOf("GrantStore");

function grantTuple(
  caps: bigint, cap: bigint, query: bigint, expiry: bigint, depth: number, ro: boolean,
) {
  return [caps, cap, 0n, query, 0n, expiry, depth, ro, false, false, 0n, 0n, 0n] as const;
}

export async function POST(req: Request) {
  const { action } = await req.json();
  const d = deployment();
  const w = broker();
  const c = client();
  const soon = BigInt(Math.floor(Date.now() / 1000) + 600);

  try {
    if (action === "grant") {
      const label = `task${Date.now().toString().slice(-5)}`;
      const hash = await w.writeContract({
        address: d.registry, abi: registryAbi, functionName: "registerWithGrant",
        args: [label, w.account.address, w.account.address, d.registry,
          grantTuple(0x04n, parseUnits("20", 18), 4n, soon, 0, false)],
      });
      await c.waitForTransactionReceipt({ hash });
      return NextResponse.json({ ok: true, txHash: hash, label });
    }

    if (action === "escalate") {
      // Deliberately over-scoped: asks for capabilities the parent does not hold.
      const hash = await w.writeContract({
        address: d.registry, abi: registryAbi, functionName: "registerOrLog",
        args: [`bad${Date.now().toString().slice(-5)}`, w.account.address, w.account.address, d.registry,
          grantTuple(0x1ffn, parseUnits("900", 18), 5000n, soon, 3, false)],
      });
      await c.waitForTransactionReceipt({ hash });
      return NextResponse.json({ ok: true, txHash: hash });
    }

    if (action === "revoke") {
      const node = BigInt(d.root ?? "1");
      const hash = await w.writeContract({
        address: d.store, abi: storeAbi, functionName: "revoke", args: [node],
      });
      await c.waitForTransactionReceipt({ hash });
      return NextResponse.json({ ok: true, txHash: hash });
    }

    return NextResponse.json({ ok: false, error: "unknown action" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.shortMessage ?? e?.message ?? e) }, { status: 500 });
  }
}
