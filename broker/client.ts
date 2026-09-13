import { createPublicClient, createWalletClient, http, type Address, type Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { readFileSync } from "node:fs";
import { hackathonSepolia } from "./chain.js";

export interface Deployment {
  chainId: number;
  store: Address;
  caps: Address;
  executor: Address;
  registry: Address;
  factory: Address;
  labels: Address;
  usdc: Address;
  pool: Address;
  swap?: Address;
  weth?: Address;
  device: Address;
  revoker: Address;
  rootAgent: Address;
  root: string;
  mandateSigner?: "device" | "software";
  // Block the deployment landed in; log scans start here.
  startBlock?: number;
  // Populated after the tree is seeded.
  risk?: string;
  exec?: string;
  probe?: string;
  riskRegistry?: Address;
}

export function loadDeployment(name = "local"): Deployment {
  return JSON.parse(readFileSync(`deployments/${name}.json`, "utf8"));
}

function chainFor(chainId: number): Chain {
  if (chainId === foundry.id) return foundry;
  if (chainId === hackathonSepolia.id) return hackathonSepolia as unknown as Chain;
  throw new Error(`unknown chain ${chainId}`);
}

export function publicClientFor(d: Deployment) {
  return createPublicClient({
    chain: chainFor(d.chainId),
    transport: http(process.env.RPC_URL ?? "http://127.0.0.1:8545"),
  });
}

export function walletClientFor(d: Deployment, privateKey: `0x${string}`) {
  return createWalletClient({
    account: privateKeyToAccount(privateKey),
    chain: chainFor(d.chainId),
    transport: http(process.env.RPC_URL ?? "http://127.0.0.1:8545"),
  });
}
