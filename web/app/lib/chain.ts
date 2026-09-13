import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseAbiItem } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { hackathonSepolia } from "../../../broker/chain";

export const GRANT_TUPLE =
  "(uint256 capabilities,uint256 spendCap,uint256 spendRemaining,uint256 queryBudget,uint256 queryRemaining,uint64 expiry,uint16 maxDepth,bool readOnly,bool revoked,bool reclaimed,uint256 parent,uint64 parentEpochAtGrant,uint64 epoch)";

export const events = {
  rootInit: parseAbiItem(`event RootInitialised(uint256 indexed node, ${GRANT_TUPLE} grant)`),
  granted: parseAbiItem(`event Granted(uint256 indexed parent, uint256 indexed child, ${GRANT_TUPLE} grant)`),
  named: parseAbiItem(`event Granted(uint256 indexed tokenId, string label, address owner, ${GRANT_TUPLE} grant)`),
  blocked: parseAbiItem(`event EscalationBlocked(address indexed attemptedBy, string label, ${GRANT_TUPLE} proposed, string reason, uint256 timestamp)`),
  revoked: parseAbiItem("event Revoked(uint256 indexed node, uint64 epoch)"),
  reclaimed: parseAbiItem("event Reclaimed(uint256 indexed node, uint256 indexed toAncestor, uint256 spend, uint256 query)"),
  registryAuthorized: parseAbiItem("event RegistryAuthorized(address indexed registry, uint256 indexed node)"),
  executed: parseAbiItem("event Executed(uint256 indexed node, uint8 indexed capBit, address target, uint256 spend, uint32 queryCost)"),
};

export function root() {
  return process.cwd().replace(/\/web$/, "");
}

// Defaults to the anvil deployment so `npm run dev` keeps working with no env set.
// ATTENUATE_DEPLOYMENT=sepolia points the same screen at the live tree.
const TARGET = process.env.ATTENUATE_DEPLOYMENT ?? "local";

export function deployment() {
  return JSON.parse(readFileSync(`${root()}/deployments/${TARGET}.json`, "utf8"));
}

function chain() {
  return TARGET === "local" ? foundry : (hackathonSepolia as never);
}

function rpc() {
  if (process.env.RPC_URL) return process.env.RPC_URL;
  // fork keeps Sepolia's chain id but the contracts live on local Anvil.
  if (TARGET === "sepolia") return "https://ethereum-sepolia.publicnode.com";
  return "http://127.0.0.1:8545";
}

export function abiOf(name: string) {
  return JSON.parse(readFileSync(`${root()}/contracts/out/${name}.sol/${name}.json`, "utf8")).abi;
}

export function client() {
  return createPublicClient({ chain: chain(), transport: http(rpc()) });
}

// The broker is a server-side process; in the demo it holds the deployer key.
export function broker() {
  const pk = (process.env.BROKER_KEY ??
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80") as `0x${string}`;
  return createWalletClient({
    account: privateKeyToAccount(pk), chain: chain(), transport: http(rpc()),
  });
}

// Anvil starts at genesis; a public Sepolia node will not scan 11M blocks, so the
// deployment records the block its contracts landed in.
export const RANGE = {
  fromBlock: BigInt(deployment().startBlock ?? 0),
  toBlock: "latest",
} as const;

export function explorerTx(hash: string) {
  if (TARGET === "sepolia") return `https://sepolia.etherscan.io/tx/${hash}`;
  const base = (process.env.ATTENUATE_EXPLORER_URL ?? "http://localhost:5100").replace(/\/$/, "");
  return `${base}/tx/${hash}`;
}

export const CAPS = [
  "swap.uniswap", "lend.aave.supply", "lend.aave.repay", "lend.aave.withdraw",
  "erc20.approve", "transfer.native", "data.graph.read", "delegate",
];

export const decodeCaps = (m: bigint) => CAPS.filter((_, i) => (m >> BigInt(i)) & 1n);

export function ago(ts: bigint) {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - Number(ts));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export const usdc = (v: bigint) => Number(v / 10n ** 16n) / 100;
