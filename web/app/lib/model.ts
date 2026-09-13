export type NodeState = "live" | "working" | "blocked" | "dead";

export interface AgentNode {
  id: string;
  name: string;
  capabilities: string[];
  spendCap: number;
  spendRemaining: number;
  queryRemaining: number;
  expiresIn: string;
  maxDepth: number;
  readOnly: boolean;
  state: NodeState;
  children: AgentNode[];
}

export type FeedKind = "granted" | "executed" | "blocked" | "revoked" | "reclaimed" | "mandate";

export interface FeedItem {
  id: string;
  kind: FeedKind;
  name: string;
  detail: string;
  reason?: string;
  txHash: string;
  txUrl?: string;
  at: string;
}

export const CAP_LABEL: Record<string, string> = {
  "swap.uniswap": "swap",
  "lend.aave.supply": "supply",
  "lend.aave.repay": "repay",
  "lend.aave.withdraw": "withdraw",
  "erc20.approve": "approve",
  "transfer.native": "send",
  "data.graph.read": "read",
  delegate: "delegate",
};

export function txUrl(hash: string, href?: string) {
  if (href) return href;
  const target = process.env.ATTENUATE_DEPLOYMENT ?? "local";
  if (target === "sepolia") return `https://sepolia.etherscan.io/tx/${hash}`;
  const base = (process.env.ATTENUATE_EXPLORER_URL ?? "http://localhost:5100").replace(/\/$/, "");
  return `${base}/tx/${hash}`;
}
