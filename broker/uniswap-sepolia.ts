import { encodeFunctionData, parseAbi, toFunctionSelector, type Address, type Hex } from "viem";

/** Official Uniswap V3 + Circle USDC on Ethereum Sepolia. */
export const UNISWAP_SEPOLIA = {
  factory: "0x0227628f3F023bb0B980b67D528571c95c6DaC1c",
  router: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E",
  npm: "0x1238536071E1c677A632429e3655c799b22cDA52",
  weth: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
  usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  fee: 3000,
} as const satisfies Record<string, Address | number>;

export const SWAP_ROUTER_ABI = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
]);

export const FACTORY_ABI = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
  "function createPool(address tokenA, address tokenB, uint24 fee) returns (address pool)",
]);

export const POOL_ABI = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function initialize(uint160 sqrtPriceX96)",
]);

export const NPM_ABI = parseAbi([
  "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
]);

export const WETH_ABI = parseAbi([
  "function deposit() payable",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);

export const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function masterMinter() view returns (address)",
  "function configureMinter(address minter, uint256 minterAllowedAmount) returns (bool)",
  "function mint(address to, uint256 amount) returns (bool)",
]);

// SwapRouter02 exactInputSingle packs one static struct: amountIn is word 4.
export const EXACT_INPUT_SINGLE_AMOUNT_INDEX = 4;
export const EXACT_INPUT_SINGLE_TOKEN_IN_INDEX = 0;

export const EXACT_INPUT_SINGLE_SELECTOR = toFunctionSelector(
  "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))",
) as Hex;

export function sortedPair(a: Address, b: Address): [Address, Address] {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

function sqrt(n: bigint): bigint {
  if (n <= 1n) return n;
  let z = n;
  let x = n / 2n + 1n;
  while (x < z) {
    z = x;
    x = (n / x + x) / 2n;
  }
  return z;
}

/** Uniswap V3 sqrtPriceX96 = sqrt(amount1 / amount0) * 2^96 */
export function encodeSqrtPriceX96(amount1: bigint, amount0: bigint): bigint {
  return sqrt((amount1 << 192n) / amount0);
}

export function encodeExactInputSingle(p: {
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
  recipient: Address;
  amountIn: bigint;
  amountOutMinimum?: bigint;
}): Hex {
  return encodeFunctionData({
    abi: SWAP_ROUTER_ABI,
    functionName: "exactInputSingle",
    args: [{
      tokenIn: p.tokenIn,
      tokenOut: p.tokenOut,
      fee: p.fee,
      recipient: p.recipient,
      amountIn: p.amountIn,
      amountOutMinimum: p.amountOutMinimum ?? 1n,
      sqrtPriceLimitX96: 0n,
    }],
  });
}
