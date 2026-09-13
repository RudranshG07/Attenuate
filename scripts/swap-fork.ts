/**
 * Swap 0.01 WETH for Circle USDC through the live Sepolia SwapRouter02,
 * gated by Executor.execute on the fork deployment.
 *
 *   npm run chain:fork
 *   npm run deploy:fork
 *   npm run swap:fork
 */
import { parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadDeployment, publicClientFor, walletClientFor } from "../broker/client.js";
import { executorAbi } from "../broker/abi.js";
import { checkScope } from "../broker/grant.js";
import { Cap } from "../broker/types.js";
import { ERC20_ABI, encodeExactInputSingle } from "../broker/uniswap-sepolia.js";

const KEY = (process.env.ATTENUATE_PRIVATE_KEY ??
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80") as `0x${string}`;

async function main() {
  const d = loadDeployment(process.env.DEPLOYMENT ?? process.env.ATTENUATE_DEPLOYMENT ?? "fork");
  if (d.swapKind !== "uniswap-v3" || !d.swap || !d.weth || !d.sepoliaUsdc) {
    throw new Error("deployments/fork.json is not a Uniswap V3 fork — run `npm run deploy:fork`");
  }

  const pub = publicClientFor(d);
  const wallet = walletClientFor(d, KEY);
  const node = BigInt(d.exec ?? d.root);
  const amountIn = parseEther("0.01");

  const [wethBefore, usdcBefore, scopeBefore] = await Promise.all([
    pub.readContract({ address: d.weth, abi: ERC20_ABI, functionName: "balanceOf", args: [d.executor] }),
    pub.readContract({ address: d.sepoliaUsdc, abi: ERC20_ABI, functionName: "balanceOf", args: [d.executor] }),
    checkScope(pub as never, d.store, node),
  ]);

  const data = encodeExactInputSingle({
    tokenIn: d.weth,
    tokenOut: d.sepoliaUsdc,
    fee: d.uniswapFee ?? 3000,
    recipient: d.executor,
    amountIn,
    amountOutMinimum: 1n,
  });

  const hash = await wallet.writeContract({
    address: d.executor,
    abi: executorAbi,
    functionName: "execute",
    args: [node, Cap.SWAP_UNISWAP, d.swap, 0n, data],
  });
  await pub.waitForTransactionReceipt({ hash });

  const [wethAfter, usdcAfter, scopeAfter] = await Promise.all([
    pub.readContract({ address: d.weth, abi: ERC20_ABI, functionName: "balanceOf", args: [d.executor] }),
    pub.readContract({ address: d.sepoliaUsdc, abi: ERC20_ABI, functionName: "balanceOf", args: [d.executor] }),
    checkScope(pub as never, d.store, node),
  ]);

  const spent = wethBefore - wethAfter;
  const bought = usdcAfter - usdcBefore;
  const budget = scopeBefore.spendRemaining - scopeAfter.spendRemaining;
  if (spent !== amountIn) throw new Error(`WETH spent ${spent}, expected ${amountIn}`);
  if (bought <= 0n) throw new Error("Circle USDC balance did not increase");
  if (budget !== amountIn) throw new Error(`grant debit ${budget}, expected ${amountIn}`);

  console.log(`swapped 0.01 WETH -> ${bought} Circle USDC (6 decimals)`);
  console.log(`pool     ${d.uniswapPool}`);
  console.log(`router   ${d.swap}`);
  console.log(`tx       ${hash}`);
  console.log(`budget   ${scopeAfter.spendRemaining} remaining`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
