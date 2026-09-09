import type { AgentNode, FeedItem } from "./model";

// Shown until a chain is connected, so the screen is never empty.
export const demoTree: AgentNode = {
  id: "1",
  name: "attenuate.eth",
  capabilities: ["swap.uniswap", "lend.aave.supply", "lend.aave.repay", "lend.aave.withdraw", "erc20.approve", "transfer.native", "data.graph.read", "delegate"],
  spendCap: 1000,
  spendRemaining: 640,
  queryRemaining: 820,
  expiresIn: "29d",
  maxDepth: 3,
  readOnly: false,
  state: "live",
  children: [
    {
      id: "2",
      name: "risk.attenuate.eth",
      capabilities: ["data.graph.read", "delegate"],
      spendCap: 260,
      spendRemaining: 150,
      queryRemaining: 140,
      expiresIn: "22h",
      maxDepth: 1,
      readOnly: true,
      state: "live",
      children: [
        {
          id: "4",
          name: "probe.risk.attenuate.eth",
          capabilities: ["data.graph.read"],
          spendCap: 110,
          spendRemaining: 110,
          queryRemaining: 40,
          expiresIn: "9m",
          maxDepth: 0,
          readOnly: true,
          state: "working",
          children: [],
        },
      ],
    },
    {
      id: "3",
      name: "exec.attenuate.eth",
      capabilities: ["lend.aave.repay"],
      spendCap: 100,
      spendRemaining: 40,
      queryRemaining: 8,
      expiresIn: "4m",
      maxDepth: 0,
      readOnly: false,
      state: "live",
      children: [],
    },
  ],
};

export const demoFeed: FeedItem[] = [
  { id: "f1", kind: "mandate", name: "attenuate.eth", detail: "root mandate signed on device, cap 1000 USDC", txHash: "0x9c41ab7d5e2f", at: "12m ago" },
  { id: "f2", kind: "granted", name: "risk.attenuate.eth", detail: "read-only, 260 USDC, expires 24h", txHash: "0x4f8ac120de91", at: "11m ago" },
  { id: "f3", kind: "granted", name: "exec.attenuate.eth", detail: "repay only, 100 USDC, expires 10m", txHash: "0xbb70e4c8a133", at: "6m ago" },
  { id: "f4", kind: "blocked", name: "exec.attenuate.eth", detail: "planner proposed swap + approve", reason: "SCOPE_WIDENED", txHash: "0x21d9f70b4cc5", at: "5m ago" },
  { id: "f5", kind: "executed", name: "exec.attenuate.eth", detail: "repaid 60 USDC to Aave pool", txHash: "0x7e3b9a05fd42", at: "3m ago" },
  { id: "f6", kind: "blocked", name: "probe.risk.attenuate.eth", detail: "planner proposed 400 USDC cap", reason: "CAP_EXCEEDS_UNALLOCATED", txHash: "0xc50a8813be7f", at: "1m ago" },
];
