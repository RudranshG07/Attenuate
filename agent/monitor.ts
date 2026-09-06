export interface PositionHealth {
  healthFactor: number;
  collateralUsd: bigint;
  debtUsd: bigint;
  liquidationThreshold: number;
  blockNumber: bigint;
  stale: boolean;
}

export async function onHealthChange(cb: (h: PositionHealth) => Promise<void>): Promise<void> {
  throw new Error("todo");
}

export async function readPosition(node: `0x${string}`): Promise<PositionHealth> {
  throw new Error("todo");
}
