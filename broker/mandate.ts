import type { RootMandate } from "./types.js";

export const ROOT_MANDATE_TYPES = {
  RootMandate: [
    { name: "rootNode", type: "bytes32" },
    { name: "capabilities", type: "uint256" },
    { name: "spendCap", type: "uint256" },
    { name: "queryBudget", type: "uint256" },
    { name: "expiry", type: "uint64" },
    { name: "maxDepth", type: "uint16" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export function domain(chainId: number, verifyingContract: `0x${string}`) {
  return {
    name: "Attenuate",
    version: "1",
    chainId,
    verifyingContract,
  };
}

export async function signRootMandate(m: RootMandate): Promise<`0x${string}`> {
  throw new Error("todo");
}
