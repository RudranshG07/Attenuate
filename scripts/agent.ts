/**
 * One sub-agent, as its own OS process, holding its own key.
 *
 * This is the claim the whole project rests on, so it is worth being able to watch it
 * fail: the process is given a name and nothing else, it derives the key for that name
 * and no other, and `Executor.execute` checks `msg.sender == STORE.agentOf(node)`. Run
 * it as a name it does not hold the key for and the chain refuses it.
 *
 *   npx tsx scripts/agent.ts exec repay 5
 *   npx tsx scripts/agent.ts probe repay 5      # read-only, refused on chain
 */
import { createWalletClient, encodeFunctionData, http, parseAbi, type Address } from "viem";
import { foundry } from "viem/chains";
import { loadDeployment, publicClientFor } from "../broker/client.js";
import { agentAccount } from "../agent/identity.js";
import { Cap } from "../broker/types.js";

const [label, action = "repay", amountArg = "5"] = process.argv.slice(2);
if (!label) {
  console.error("usage: tsx scripts/agent.ts <label> [repay|health] [amount]");
  process.exit(1);
}

const d = loadDeployment(process.env.ATTENUATE_DEPLOYMENT ?? "local");
const pub = publicClientFor(d) as never;
const account = agentAccount(label);
const wallet = createWalletClient({
  account, chain: foundry,
  transport: http(process.env.RPC_URL ?? "http://127.0.0.1:8545"),
});

const storeAbi = parseAbi([
  "function agentOf(uint256) view returns (address)",
  "function isLive(uint256) view returns (bool)",
]);
const executorAbi = parseAbi([
  "function execute(uint256 node,uint8 capBit,address target,uint256 value,bytes data) returns (bytes)",
]);
const poolAbi = parseAbi([
  "function repay(address asset,uint256 amount,uint256 rateMode,address onBehalfOf)",
  "function healthFactor(address who) view returns (uint256)",
]);

// The revert string is the useful part and viem buries it, so pull the first
// SCREAMING_CASE token out of whatever it hands back.
const REASONS = [
  "NOT_AGENT", "CAP_MISSING", "REVOKED_OR_EXPIRED", "OVER_BUDGET",
  "OVER_QUERY_BUDGET", "READ_ONLY", "TARGET_MISMATCH", "SELECTOR_MISMATCH",
  "ARG_PINNED", "CAP_DISABLED", "NOT_LIVE",
];

function reasonOf(e: unknown): string {
  const s = JSON.stringify(e instanceof Error ? (e.message ?? "") : e) +
    JSON.stringify((e as { shortMessage?: string }).shortMessage ?? "");
  for (const r of REASONS) if (s.includes(r)) return r;
  return (e as { shortMessage?: string }).shortMessage ?? "reverted";
}

async function main() {
  const node = BigInt((d as unknown as Record<string, string>)[label]);
  const onChain = await pub.readContract({
    address: d.store, abi: storeAbi, functionName: "agentOf", args: [node],
  }) as Address;

  console.log(`agent   ${label}.attenuate.eth`);
  console.log(`pid     ${process.pid}`);
  console.log(`key     ${account.address}`);
  console.log(`agentOf ${onChain}`);
  console.log(`holds   ${onChain.toLowerCase() === account.address.toLowerCase()}`);

  const amount = BigInt(amountArg) * 10n ** 18n;
  const [capBit, data] = action === "health"
    ? [Cap.DATA_GRAPH_READ, encodeFunctionData({
        abi: poolAbi, functionName: "healthFactor", args: [d.executor],
      })]
    : [Cap.LEND_AAVE_REPAY, encodeFunctionData({
        abi: poolAbi, functionName: "repay",
        args: [d.usdc, amount, 2n, d.executor],
      })];

  try {
    const hash = await wallet.writeContract({
      address: d.executor, abi: executorAbi, functionName: "execute",
      args: [node, capBit, d.pool, 0n, data],
    } as never);
    await pub.waitForTransactionReceipt({ hash });
    console.log(`\nEXECUTED ${action} — ${hash}`);
  } catch (e) {
    console.log(`\nREFUSED  ${reasonOf(e)}`);
    process.exit(2);
  }
}

main().catch((e) => { console.error(e?.shortMessage ?? e?.message ?? e); process.exit(1); });
