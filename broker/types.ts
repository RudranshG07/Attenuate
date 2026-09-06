export interface Grant {
  capabilities: bigint;
  spendCap: bigint;
  spendRemaining: bigint;
  queryBudget: bigint;
  queryRemaining: bigint;
  expiry: bigint;
  maxDepth: number;
  readOnly: boolean;
  revoked: boolean;
  reclaimed: boolean;
  parent: `0x${string}`;
  parentEpochAtGrant: bigint;
  epoch: bigint;
}

export interface RootMandate {
  rootNode: `0x${string}`;
  capabilities: bigint;
  spendCap: bigint;
  queryBudget: bigint;
  expiry: bigint;
  maxDepth: number;
  nonce: bigint;
}

export const Cap = {
  SWAP_UNISWAP: 0,
  LEND_AAVE_SUPPLY: 1,
  LEND_AAVE_REPAY: 2,
  LEND_AAVE_WITHDRAW: 3,
  ERC20_APPROVE: 4,
  TRANSFER_NATIVE: 5,
  DATA_GRAPH_READ: 6,
  DELEGATE: 7,
} as const;
