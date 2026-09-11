import { parseAbi, type Address, type PublicClient } from "viem";
import { loadDeployment, publicClientFor, type Deployment } from "../broker/client.js";

export interface PositionHealth {
  healthFactor: number;
  collateralUsd: bigint;
  debtUsd: bigint;
  liquidationThreshold: number;
  blockNumber: bigint;
  // Set when a reorg has invalidated the block this reading came from. A guard that
  // acts on rolled-back state is worse than one that waits.
  stale: boolean;
}

const poolAbi = parseAbi([
  "function healthFactor(address who) view returns (uint256)",
  "function debtOf(address who) view returns (uint256)",
  "function suppliedOf(address who) view returns (uint256)",
]);

export const LIQUIDATION_THRESHOLD = 1.0;

export async function readPosition(
  account: Address,
  d: Deployment = loadDeployment(process.env.ATTENUATE_DEPLOYMENT ?? "local"),
  client: PublicClient = publicClientFor(d) as unknown as PublicClient,
): Promise<PositionHealth> {
  const [hf, debt, supplied, block] = await Promise.all([
    client.readContract({ address: d.pool, abi: poolAbi, functionName: "healthFactor", args: [account] }) as Promise<bigint>,
    client.readContract({ address: d.pool, abi: poolAbi, functionName: "debtOf", args: [account] }) as Promise<bigint>,
    client.readContract({ address: d.pool, abi: poolAbi, functionName: "suppliedOf", args: [account] }) as Promise<bigint>,
    client.getBlockNumber(),
  ]);

  // healthFactor returns uint256 max when there is no debt.
  const healthFactor = debt === 0n ? Infinity : Number(hf) / 1e18;

  return {
    healthFactor,
    collateralUsd: supplied,
    debtUsd: debt,
    liquidationThreshold: LIQUIDATION_THRESHOLD,
    blockNumber: block,
    stale: false,
  };
}

// Push, not polling. A guard five minutes late is a preference for an app that
// displays and a bug for one that spends.
export async function onHealthChange(
  account: Address,
  cb: (h: PositionHealth) => Promise<void>,
): Promise<() => void> {
  const d = loadDeployment(process.env.ATTENUATE_DEPLOYMENT ?? "local");
  const client = publicClientFor(d) as unknown as PublicClient;

  let last: number | null = null;
  const unwatch = client.watchBlockNumber({
    emitOnBegin: true,
    onBlockNumber: async () => {
      const h = await readPosition(account, d, client);
      if (last === null || h.healthFactor !== last) {
        last = h.healthFactor;
        await cb(h);
      }
    },
  });
  return unwatch;
}
