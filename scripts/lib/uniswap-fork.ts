import {
  createWalletClient,
  parseEther,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import {
  ERC20_ABI,
  EXACT_INPUT_SINGLE_AMOUNT_INDEX,
  EXACT_INPUT_SINGLE_TOKEN_IN_INDEX,
  FACTORY_ABI,
  NPM_ABI,
  POOL_ABI,
  SWAP_ROUTER_ABI,
  UNISWAP_SEPOLIA,
  WETH_ABI,
  encodeSqrtPriceX96,
  sortedPair,
} from "../../broker/uniswap-sepolia.js";

const FEE = UNISWAP_SEPOLIA.fee;
const WETH = UNISWAP_SEPOLIA.weth as Address;
const USDC = UNISWAP_SEPOLIA.usdc as Address;
const FACTORY = UNISWAP_SEPOLIA.factory as Address;
const ROUTER = UNISWAP_SEPOLIA.router as Address;
const NPM = UNISWAP_SEPOLIA.npm as Address;

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

export interface UniswapFork {
  router: Address;
  factory: Address;
  npm: Address;
  weth: Address;
  usdc: Address;
  pool: Address;
  fee: number;
  seeded: boolean;
}

async function wait(pub: PublicClient, hash: Hex) {
  await pub.waitForTransactionReceipt({ hash });
}

async function mustHaveCode(pub: PublicClient, name: string, address: Address) {
  const code = await pub.getCode({ address });
  if (!code || code === "0x") throw new Error(`${name} has no code on this fork: ${address}`);
}

function impersonated(address: Address, chain: Chain, transport: WalletClient["transport"]): WalletClient {
  return createWalletClient({ account: address, chain, transport });
}

async function mintCircleUsdc(
  pub: PublicClient,
  wallet: WalletClient,
  to: Address,
  amount: bigint,
) {
  const masterMinter = await pub.readContract({
    address: USDC, abi: ERC20_ABI, functionName: "masterMinter",
  }) as Address;

  await pub.request({ method: "anvil_impersonateAccount" as never, params: [masterMinter] as never });
  await pub.request({
    method: "anvil_setBalance" as never,
    params: [masterMinter, `0x${parseEther("10").toString(16)}`] as never,
  });

  const mm = impersonated(masterMinter, wallet.chain!, wallet.transport);
  await wait(pub, await mm.writeContract({
    address: USDC, abi: ERC20_ABI, functionName: "configureMinter",
    args: [wallet.account!.address, amount],
  }));
  await pub.request({ method: "anvil_stopImpersonatingAccount" as never, params: [masterMinter] as never });

  await wait(pub, await wallet.writeContract({
    address: USDC, abi: ERC20_ABI, functionName: "mint",
    args: [to, amount],
  }));
}

/**
 * Point SWAP at the live Sepolia SwapRouter02. If the WETH/USDC 0.3% pool is
 * missing or empty at this fork block, create/initialize it and add full-range
 * liquidity through the official NonfungiblePositionManager.
 */
export async function wireUniswapOnFork(
  pub: PublicClient,
  wallet: WalletClient,
  executor: Address,
): Promise<UniswapFork> {
  console.log("\nwiring live Uniswap V3 (SwapRouter02)");
  await mustHaveCode(pub, "SwapRouter02", ROUTER);
  await mustHaveCode(pub, "UniswapV3Factory", FACTORY);
  await mustHaveCode(pub, "NonfungiblePositionManager", NPM);
  await mustHaveCode(pub, "WETH9", WETH);
  await mustHaveCode(pub, "Circle USDC", USDC);
  console.log(`  factory  ${FACTORY}`);
  console.log(`  router   ${ROUTER}`);
  console.log(`  weth     ${WETH}`);
  console.log(`  usdc     ${USDC}`);

  let pool = await pub.readContract({
    address: FACTORY, abi: FACTORY_ABI, functionName: "getPool",
    args: [WETH, USDC, FEE],
  }) as Address;

  if (pool === ZERO) {
    const hash = await wallet.writeContract({
      address: FACTORY, abi: FACTORY_ABI, functionName: "createPool",
      args: [WETH, USDC, FEE],
    });
    await wait(pub, hash);
    pool = await pub.readContract({
      address: FACTORY, abi: FACTORY_ABI, functionName: "getPool",
      args: [WETH, USDC, FEE],
    }) as Address;
    if (pool === ZERO) throw new Error("createPool returned zero");
    console.log(`  created pool ${pool}`);
  } else {
    console.log(`  existing pool ${pool}`);
  }

  const slot0 = await pub.readContract({
    address: pool, abi: POOL_ABI, functionName: "slot0",
  }) as { sqrtPriceX96: bigint };
  if (slot0.sqrtPriceX96 === 0n) {
    // token0 = USDC (6), token1 = WETH (18). 1 WETH ≈ 3000 USDC.
    const [token0] = sortedPair(WETH, USDC);
    const price = token0.toLowerCase() === USDC.toLowerCase()
      ? encodeSqrtPriceX96(10n ** 18n, 3000n * 10n ** 6n)
      : encodeSqrtPriceX96(3000n * 10n ** 6n, 10n ** 18n);
    await wait(pub, await wallet.writeContract({
      address: pool, abi: POOL_ABI, functionName: "initialize", args: [price],
    }));
    console.log("  initialized pool at ~3000 USDC/WETH");
  }

  const liquidity = await pub.readContract({
    address: pool, abi: POOL_ABI, functionName: "liquidity",
  }) as bigint;
  const poolWeth = await pub.readContract({
    address: WETH, abi: ERC20_ABI, functionName: "balanceOf", args: [pool],
  }) as bigint;
  const poolUsdc = await pub.readContract({
    address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [pool],
  }) as bigint;
  const thin = liquidity === 0n || poolWeth < parseEther("1") || poolUsdc < 1_000n * 10n ** 6n;

  let seeded = false;
  if (thin) {
    seeded = true;
    const usdcIn = 3_000_000n * 10n ** 6n;
    const wethIn = parseEther("1000");
    await mintCircleUsdc(pub, wallet, wallet.account!.address, usdcIn);
    await wait(pub, await wallet.writeContract({
      address: WETH, abi: WETH_ABI, functionName: "deposit", value: wethIn,
    }));
    await wait(pub, await wallet.writeContract({
      address: USDC, abi: ERC20_ABI, functionName: "approve", args: [NPM, usdcIn],
    }));
    await wait(pub, await wallet.writeContract({
      address: WETH, abi: WETH_ABI, functionName: "approve", args: [NPM, wethIn],
    }));

    const [token0, token1] = sortedPair(USDC, WETH);
    const amount0Desired = token0.toLowerCase() === USDC.toLowerCase() ? usdcIn : wethIn;
    const amount1Desired = token1.toLowerCase() === WETH.toLowerCase() ? wethIn : usdcIn;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

    await wait(pub, await wallet.writeContract({
      address: NPM, abi: NPM_ABI, functionName: "mint",
      args: [{
        token0, token1, fee: FEE,
        tickLower: -887220, tickUpper: 887220,
        amount0Desired, amount1Desired,
        amount0Min: 0n, amount1Min: 0n,
        recipient: wallet.account!.address,
        deadline,
      }],
    }));
    const after = await pub.readContract({
      address: pool, abi: POOL_ABI, functionName: "liquidity",
    }) as bigint;
    if (after === 0n) throw new Error("NPM mint left the pool with zero liquidity");
    console.log(`  seeded full-range liquidity ${after}`);
  } else {
    console.log(`  pool already has liquidity ${liquidity}`);
  }

  const executorWeth = parseEther("5");
  await wait(pub, await wallet.writeContract({
    address: WETH, abi: WETH_ABI, functionName: "deposit", value: executorWeth,
  }));
  await wait(pub, await wallet.writeContract({
    address: WETH, abi: WETH_ABI, functionName: "transfer",
    args: [executor, executorWeth],
  }));
  console.log(`  funded executor with 5 WETH`);

  return {
    router: ROUTER,
    factory: FACTORY,
    npm: NPM,
    weth: WETH,
    usdc: USDC,
    pool,
    fee: FEE,
    seeded,
  };
}

export { EXACT_INPUT_SINGLE_AMOUNT_INDEX, EXACT_INPUT_SINGLE_TOKEN_IN_INDEX, SWAP_ROUTER_ABI };
