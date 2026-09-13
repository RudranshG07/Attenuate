import {
  createWalletClient,
  createPublicClient,
  http,
  encodeFunctionData,
  decodeEventLog,
  type Address,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { agentAddress } from "../agent/identity.js";
import { foundry } from "viem/chains";
import { readFileSync } from "node:fs";
import { loadDeployment } from "../broker/client.js";
import { hackathonSepolia } from "../broker/chain.js";
import { checkScope, decodeCapabilities, newGrant, simulateGrant } from "../broker/grant.js";
import { Cap } from "../broker/types.js";

const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const REVOKER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

const DEPLOYMENT = process.env.DEPLOYMENT ?? "local";
const account = privateKeyToAccount(ANVIL_KEY);
const revokerAccount = privateKeyToAccount(REVOKER_KEY);
const transport = http(process.env.RPC_URL ?? "http://127.0.0.1:8545");

function chainFor(chainId: number): Chain {
  if (chainId === foundry.id) return foundry;
  if (chainId === hackathonSepolia.id) return hackathonSepolia as unknown as Chain;
  throw new Error(`unknown chain ${chainId}`);
}

function artifact(name: string) {
  return JSON.parse(readFileSync(`contracts/out/${name}.sol/${name}.json`, "utf8"));
}

function grantTuple(g: ReturnType<typeof newGrant>) {
  return [
    g.capabilities, g.spendCap, g.spendRemaining, g.queryBudget, g.queryRemaining,
    g.expiry, g.maxDepth, g.readOnly, g.revoked, g.reclaimed,
    g.parent, g.parentEpochAtGrant, g.epoch,
  ] as const;
}

function ok(label: string, detail = "") {
  console.log(`  OK     ${label}${detail ? ` — ${detail}` : ""}`);
}
function block(label: string, reason: string) {
  console.log(`  BLOCK  ${label} — ${reason}`);
}
function fail(label: string, detail: string): never {
  console.error(`  FAIL   ${label} — ${detail}`);
  process.exit(1);
}

async function main() {
  const d = loadDeployment(DEPLOYMENT);
  if (!d.registry || !d.exec || !d.usdc || !d.pool) {
    fail("deploy", `deployments/${DEPLOYMENT}.json is incomplete — run the matching deploy script`);
  }

  const chain = chainFor(d.chainId);
  const wallet = createWalletClient({ account, chain, transport });
  const revoker = createWalletClient({ account: revokerAccount, chain, transport });
  const pub = createPublicClient({ chain, transport });

  async function mintLabel(registry: Address, label: string, grant: ReturnType<typeof newGrant>) {
    const abi = artifact("AttenuatedSubregistry").abi;
    const hash = await wallet.writeContract({
      address: registry,
      abi,
      functionName: "registerWithGrant",
      args: [label, account.address, account.address, grantTuple(grant)],
    } as never);
    const r = await pub.waitForTransactionReceipt({ hash });
    for (const log of r.logs) {
      try {
        const e = decodeEventLog({ abi, data: log.data, topics: log.topics });
        if (e.eventName === "Granted") return (e.args as { tokenId: bigint }).tokenId;
      } catch {
        // ignore
      }
    }
    throw new Error(`no Granted event for ${label}`);
  }

  console.log(`smoke against deployments/${DEPLOYMENT}.json (chainId ${d.chainId})\n`);

  const storeAbi = artifact("GrantStore").abi;
  const registryAbi = artifact("AttenuatedSubregistry").abi;
  const executorAbi = artifact("Executor").abi;
  const poolAbi = artifact("MockPool").abi;
  const erc20Abi = artifact("MockERC20").abi;

  const ROOT = BigInt(d.root);
  const execNode = BigInt(d.exec);
  const day = BigInt(Math.floor(Date.now() / 1000) + 86400);

  console.log("1. root scope");
  const root = await checkScope(pub as never, d.store, ROOT);
  if (!root.live) fail("root", "not live");
  ok("root live", `caps=${decodeCapabilities(root.capabilities).length} remaining=${root.spendRemaining / 10n ** 18n} eth depth=${root.maxDepth}`);

  console.log("\n2. simulate grants against root");
  const base = { owner: account.address, resolver: account.address };
  const cases: [string, ReturnType<typeof newGrant>, boolean][] = [
    ["in scope (repay, 50)", newGrant({ capabilities: 1n << BigInt(Cap.LEND_AAVE_REPAY), spendCap: 50n * 10n ** 18n, queryBudget: 1n, expiry: day, maxDepth: 0 }), true],
    ["capability parent lacks", newGrant({ capabilities: 1n << 8n, spendCap: 1n, expiry: day, maxDepth: 0 }), false],
    ["over parent budget", newGrant({ capabilities: 1n << BigInt(Cap.LEND_AAVE_REPAY), spendCap: 5000n * 10n ** 18n, expiry: day, maxDepth: 0 }), false],
    ["expiry beyond parent", newGrant({ capabilities: 1n << BigInt(Cap.LEND_AAVE_REPAY), spendCap: 1n, expiry: root.expiry + 1n, maxDepth: 0 }), false],
    ["depth not narrowing", newGrant({ capabilities: 1n << BigInt(Cap.LEND_AAVE_REPAY), spendCap: 1n, expiry: day, maxDepth: root.maxDepth }), false],
  ];
  for (const [label, grant, expectOk] of cases) {
    const r = await simulateGrant(pub as never, d.registry, account.address, { label: `smoke-${label.slice(0, 8)}`, ...base, grant });
    if (r.ok !== expectOk) fail(label, `expected ${expectOk ? "ok" : "block"}, got ${r.ok ? "ok" : r.reason}`);
    if (r.ok) ok(label);
    else block(label, `${r.reason}${r.field ? ` (${r.field})` : ""}`);
  }

  console.log("\n3. grant a fresh leaf and execute a repay");
  const leafLabel = `leaf${Date.now().toString(36).slice(-4)}`;
  const leafGrant = newGrant({
    capabilities: (1n << BigInt(Cap.LEND_AAVE_REPAY)) | (1n << BigInt(Cap.ERC20_APPROVE)) | (1n << BigInt(Cap.DATA_GRAPH_READ)),
    spendCap: 25n * 10n ** 18n,
    queryBudget: 5n,
    expiry: day,
    maxDepth: 0,
  });
  const leaf = await mintLabel(d.registry, leafLabel, leafGrant);
  ok("minted leaf", `token ${leaf}`);

  const beforeBal = await pub.readContract({
    address: d.usdc, abi: erc20Abi, functionName: "balanceOf", args: [d.executor],
  }) as bigint;

  const repayData = encodeFunctionData({
    abi: poolAbi,
    functionName: "repay",
    args: [d.usdc, 5n * 10n ** 18n, 0n, d.executor],
  });
  const execHash = await wallet.writeContract({
    address: d.executor,
    abi: executorAbi,
    functionName: "execute",
    args: [leaf, Cap.LEND_AAVE_REPAY, d.pool, 0n, repayData],
  } as never);
  await pub.waitForTransactionReceipt({ hash: execHash });

  const afterBal = await pub.readContract({
    address: d.usdc, abi: erc20Abi, functionName: "balanceOf", args: [d.executor],
  }) as bigint;
  if (beforeBal - afterBal !== 5n * 10n ** 18n) fail("execute", `balance delta ${beforeBal - afterBal}`);
  ok("execute repay", "5 USDC moved from executor to pool");

  const scopeAfter = await checkScope(pub as never, d.store, leaf);
  if (scopeAfter.spendRemaining !== 20n * 10n ** 18n) fail("budget", `remaining ${scopeAfter.spendRemaining}`);
  ok("spend budget debited", `remaining ${scopeAfter.spendRemaining / 10n ** 18n} eth`);

  console.log("\n4. refused escalation from the leaf (maxDepth 0)");
  // A leaf has no child registry. Escalation is refused at the parent: widen against root.
  const widened = await simulateGrant(pub as never, d.registry, account.address, {
    label: "widen",
    ...base,
    grant: newGrant({ capabilities: 1n << 8n, spendCap: 1n, expiry: day, maxDepth: 0 }),
  });
  if (widened.ok || widened.reason !== "SCOPE_WIDENED") fail("escalation", `got ${widened.reason}`);
  block("child sets bit parent lacks", "SCOPE_WIDENED");

  // Over-budget execute on the seeded exec node.
  const over = encodeFunctionData({
    abi: poolAbi,
    functionName: "repay",
    args: [d.usdc, 10_000n * 10n ** 18n, 0n, d.executor],
  });
  try {
    await pub.simulateContract({
      address: d.executor,
      abi: executorAbi,
      functionName: "execute",
      args: [execNode, Cap.LEND_AAVE_REPAY, d.pool, 0n, over],
      // exec holds its own key, so the budget check is only reachable as exec.
      account: agentAddress("exec"),
    });
    fail("over budget", "simulate should have reverted");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("OVER_BUDGET")) fail("over budget", msg);
    block("execute above spendCap", "OVER_BUDGET");
  }

  console.log("\n5. revoke the leaf, then refuse execute and reclaim");
  const revokeHash = await revoker.writeContract({
    address: d.registry,
    abi: registryAbi,
    functionName: "revokeGrant",
    args: [leaf],
  } as never);
  await pub.waitForTransactionReceipt({ hash: revokeHash });
  ok("revoked leaf");

  const dead = await checkScope(pub as never, d.store, leaf);
  if (dead.live) fail("revoke", "still live");
  ok("isLive false after revoke");

  try {
    await pub.simulateContract({
      address: d.executor,
      abi: executorAbi,
      functionName: "execute",
      args: [leaf, Cap.LEND_AAVE_REPAY, d.pool, 0n, repayData],
      account: account.address,
    });
    fail("post-revoke execute", "should have reverted");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("REVOKED_OR_EXPIRED")) fail("post-revoke execute", msg);
    block("execute after revoke", "REVOKED_OR_EXPIRED");
  }

  const remainingBefore = (await checkScope(pub as never, d.store, ROOT)).spendRemaining;
  const reclaimHash = await wallet.writeContract({
    address: d.store,
    abi: storeAbi,
    functionName: "reclaim",
    args: [leaf],
  } as never);
  await pub.waitForTransactionReceipt({ hash: reclaimHash });
  const remainingAfter = (await checkScope(pub as never, d.store, ROOT)).spendRemaining;
  const returned = remainingAfter - remainingBefore;
  // 25 minted, 5 spent → 20 should return to root.
  if (returned !== 20n * 10n ** 18n) fail("reclaim", `returned ${returned}`);
  ok("reclaim", `returned ${returned / 10n ** 18n} eth to root`);

  if (d.swapKind === "uniswap-v3" && d.swap && d.weth && d.sepoliaUsdc) {
    console.log("\n6. real Uniswap V3 swap via Executor");
    const { encodeExactInputSingle } = await import("../broker/uniswap-sepolia.js");
    const amountIn = 10n ** 16n; // 0.01 WETH
    const wethBefore = await pub.readContract({
      address: d.weth, abi: erc20Abi, functionName: "balanceOf", args: [d.executor],
    }) as bigint;
    const usdcBefore = await pub.readContract({
      address: d.sepoliaUsdc, abi: erc20Abi, functionName: "balanceOf", args: [d.executor],
    }) as bigint;
    const swapData = encodeExactInputSingle({
      tokenIn: d.weth, tokenOut: d.sepoliaUsdc, fee: d.uniswapFee ?? 3000,
      recipient: d.executor, amountIn, amountOutMinimum: 1n,
    });
    const swapHash = await wallet.writeContract({
      address: d.executor, abi: executorAbi, functionName: "execute",
      args: [ROOT, Cap.SWAP_UNISWAP, d.swap, 0n, swapData],
    } as never);
    await pub.waitForTransactionReceipt({ hash: swapHash });
    const wethAfter = await pub.readContract({
      address: d.weth, abi: erc20Abi, functionName: "balanceOf", args: [d.executor],
    }) as bigint;
    const usdcAfter = await pub.readContract({
      address: d.sepoliaUsdc, abi: erc20Abi, functionName: "balanceOf", args: [d.executor],
    }) as bigint;
    if (wethBefore - wethAfter !== amountIn) fail("uniswap", `WETH delta ${wethBefore - wethAfter}`);
    if (usdcAfter <= usdcBefore) fail("uniswap", `Circle USDC did not increase (${usdcBefore} -> ${usdcAfter})`);
    ok("uniswap v3 exactInputSingle", `0.01 WETH -> ${usdcAfter - usdcBefore} Circle USDC  ${swapHash}`);
  }

  console.log("\nsmoke passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
