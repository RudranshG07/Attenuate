/**
 * Move the demo position into a chosen band, so a recording can walk the decision tree
 * on purpose instead of waiting for a number to drift.
 *
 *   npx tsx scripts/set-health.ts 1.3    # watch band: agents delegate
 *   npx tsx scripts/set-health.ts 0.4    # critical: agents act, then get refused
 */
import { parseAbi } from "viem";
import { loadDeployment, publicClientFor, walletClientFor } from "../broker/client.js";

const target = Number(process.argv[2] ?? "1.3");
if (!Number.isFinite(target) || target <= 0) {
  console.error("usage: tsx scripts/set-health.ts <healthFactor>");
  process.exit(1);
}

const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const poolAbi = parseAbi([
  "function setDebt(address who,uint256 amount)",
  "function suppliedOf(address) view returns (uint256)",
  "function healthFactor(address who) view returns (uint256)",
]);

async function main() {
  const d = loadDeployment(process.env.ATTENUATE_DEPLOYMENT ?? "local");
  const pub = publicClientFor(d) as never;
  const wallet = walletClientFor(d, (process.env.BROKER_KEY ?? ANVIL_KEY) as `0x${string}`);

  // healthFactor is supplied/debt, so the debt is the knob that does not need funding.
  const supplied = (await pub.readContract({
    address: d.pool, abi: poolAbi, functionName: "suppliedOf", args: [d.executor],
  })) as bigint;
  if (supplied === 0n) throw new Error("nothing supplied; run deploy:local first");

  const debt = (supplied * 1_000_000n) / BigInt(Math.round(target * 1_000_000));
  const hash = await wallet.writeContract({
    address: d.pool, abi: poolAbi, functionName: "setDebt", args: [d.executor, debt],
  } as never);
  await pub.waitForTransactionReceipt({ hash });

  const hf = (await pub.readContract({
    address: d.pool, abi: poolAbi, functionName: "healthFactor", args: [d.executor],
  })) as bigint;
  console.log(`health factor now ${(Number(hf) / 1e18).toFixed(3)}  (debt ${debt / 10n ** 18n})`);
}

main().catch((e) => { console.error(e?.shortMessage ?? e?.message ?? e); process.exit(1); });
