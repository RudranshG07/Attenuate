import type { Address, Hex, TypedDataDomain } from "viem";
import { hashTypedData } from "viem";
import { signTypedData } from "./keyring.js";

export interface RootMandate {
  node: bigint;
  capabilities: bigint;
  spendCap: bigint;
  queryBudget: bigint;
  expiry: bigint;
  maxDepth: number;
  nonce: bigint;
}

export const ROOT_MANDATE_TYPES = {
  RootMandate: [
    { name: "node", type: "uint256" },
    { name: "capabilities", type: "uint256" },
    { name: "spendCap", type: "uint256" },
    { name: "queryBudget", type: "uint256" },
    { name: "expiry", type: "uint64" },
    { name: "maxDepth", type: "uint16" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export function domain(chainId: number, verifyingContract: Address): TypedDataDomain {
  return { name: "Attenuate", version: "1", chainId, verifyingContract };
}

export function mandateDigest(
  chainId: number,
  store: Address,
  m: RootMandate,
): Hex {
  return hashTypedData({
    domain: domain(chainId, store),
    types: ROOT_MANDATE_TYPES,
    primaryType: "RootMandate",
    message: m,
  });
}

export async function signRootMandate(
  chainId: number,
  store: Address,
  m: RootMandate,
): Promise<Hex> {
  return signTypedData(domain(chainId, store), ROOT_MANDATE_TYPES, {
    primaryType: "RootMandate",
    message: { ...m },
  });
}
