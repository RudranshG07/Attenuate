/**
 * One decision cycle against the live tree. Reads the pool, decides, then
 * executes / delegates / escalates on chain. Nothing is faked.
 *
 *   npm run agent
 *   ATTENUATE_AGENT_NODE=<id> npm run agent
 *   npm run agent -- --watch
 */
import { decodeEventLog, encodeFunctionData, parseAbi } from "viem";
import { grantStoreAbi, registryAbi, executorAbi } from "../broker/abi.js";
import { loadDeployment, publicClientFor, walletClientFor } from "../broker/client.js";
import { newGrant, tuple } from "../broker/grant.js";
import { deviceAvailable, requestApproval } from "../broker/keyring.js";
import { Cap, type Grant } from "../broker/types.js";
import { decide, spawnSubAgent } from "../agent/decide.js";
import { onHealthChange, readPosition } from "../agent/monitor.js";
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

const poolAbi = parseAbi([
  "function repay(address asset, uint256 amount, uint256 rate, address onBehalfOf) returns (uint256)",
]);

function brokerKey(): `0x${string}` {
  return (process.env.ATTENUATE_PRIVATE_KEY ?? process.env.BROKER_KEY ?? ANVIL_KEY) as `0x${string}`;
}

function nodeFromEnv(d: { exec?: string; root: string }): bigint {
  if (process.env.ATTENUATE_AGENT_NODE) return BigInt(process.env.ATTENUATE_AGENT_NODE);
  if (d.exec) return BigInt(d.exec);
  return BigInt(d.root);
}

async function grantOf(store: Address, node: bigint, pub: ReturnType<typeof publicClientFor>): Promise<Grant> {
  return (await pub.readContract({
    address: store, abi: grantStoreAbi, functionName: "grantOf", args: [node],
  })) as Grant;
}

async function cycle() {
  const d = loadDeployment(process.env.ATTENUATE_DEPLOYMENT ?? "local");
  const pub = publicClientFor(d);
  const wallet = walletClientFor(d, brokerKey());
  const node = nodeFromEnv(d);
  const name = process.env.ATTENUATE_AGENT_NAME ?? `node-${node}`;

  const grant = await grantOf(d.store, node, pub);
  if (grant.epoch === 0n) throw new Error(`no grant at node ${node}`);

  const pos = await readPosition(d.executor, d, pub as never);
  const decision = decide(pos, grant);
  console.log(`${name}  health=${Number.isFinite(pos.healthFactor) ? pos.healthFactor.toFixed(3) : "inf"}  ${decision.kind}  ${decision.why}`);

  if (decision.kind === "none") return;

  if (decision.kind === "act") {
    const data = encodeFunctionData({
      abi: poolAbi,
      functionName: "repay",
      args: [d.usdc, decision.amount, 0n, d.executor],
    });
    const hash = await wallet.writeContract({
      address: d.executor,
      abi: executorAbi,
      functionName: "execute",
      args: [node, decision.capBit, d.pool, 0n, data],
    });
    await pub.waitForTransactionReceipt({ hash });
    console.log(`  repaid ${decision.amount}  ${hash}`);
    return;
  }

  if (decision.kind === "delegate") {
    const registry = (node.toString() === d.risk && d.riskRegistry) ? d.riskRegistry : d.registry;
    const expiry = grant.expiry < BigInt(Math.floor(Date.now() / 1000) + 3600)
      ? grant.expiry
      : BigInt(Math.floor(Date.now() / 1000) + 3600);
    const child = newGrant({
      capabilities: decision.readOnly
        ? (1n << BigInt(Cap.DATA_GRAPH_READ))
        : (1n << BigInt(Cap.LEND_AAVE_REPAY)) | (1n << BigInt(Cap.ERC20_APPROVE)) | (1n << BigInt(Cap.DATA_GRAPH_READ)),
      spendCap: decision.readOnly ? 0n : grant.spendRemaining,
      queryBudget: decision.readOnly ? (grant.queryRemaining > 0n ? 1n : 0n) : 0n,
      expiry,
      maxDepth: 0,
      readOnly: decision.readOnly,
    });
    const label = `${decision.label}${Date.now().toString(36).slice(-4)}`;
    const hash = await wallet.writeContract({
      address: registry,
      abi: registryAbi,
      functionName: "registerWithGrant",
      args: [label, wallet.account.address, wallet.account.address, tuple(child)],
    });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    let childNode: bigint | undefined;
    for (const log of receipt.logs) {
      try {
        const e = decodeEventLog({ abi: registryAbi, data: log.data, topics: log.topics });
        if (e.eventName === "Granted") childNode = (e.args as { tokenId: bigint }).tokenId;
      } catch {
        // ignore
      }
    }
    if (!childNode) throw new Error(`no Granted event for ${label}`);
    console.log(`  delegated ${label} -> ${childNode}  ${hash}`);
    await spawnSubAgent(label, childNode);
    return;
  }

  const needed = grant.spendRemaining + 1n;
  if (deviceAvailable()) {
    await requestApproval({
      name,
      reason: decision.why,
      needed,
      allowed: grant.spendRemaining,
    });
  }

  const ownRegistry =
    (node.toString() === d.root ? d.registry : undefined) ??
    (d.risk && node.toString() === d.risk ? d.riskRegistry : undefined);

  if (ownRegistry) {
    const over = newGrant({
      capabilities: grant.capabilities,
      spendCap: needed,
      queryBudget: 0n,
      expiry: grant.expiry,
      maxDepth: 0,
    });
    const label = `esc${Date.now().toString(36).slice(-4)}`;
    const hash = await wallet.writeContract({
      address: ownRegistry,
      abi: registryAbi,
      functionName: "registerOrLog",
      args: [label, wallet.account.address, wallet.account.address, tuple(over)],
    });
    await pub.waitForTransactionReceipt({ hash });
    console.log(`  escalated ${label} (logged at parent)  ${hash}`);
    return;
  }

  const data = encodeFunctionData({
    abi: poolAbi,
    functionName: "repay",
    args: [d.usdc, needed, 0n, d.executor],
  });
  try {
    await wallet.writeContract({
      address: d.executor,
      abi: executorAbi,
      functionName: "execute",
      args: [node, Cap.LEND_AAVE_REPAY, d.pool, 0n, data],
    });
    throw new Error("over-budget execute was accepted");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("OVER_BUDGET") && !msg.includes("over-budget")) throw e;
    console.log(`  escalate refused on-chain  OVER_BUDGET`);
  }
}

async function main() {
  if (process.argv.includes("--watch")) {
    const d = loadDeployment(process.env.ATTENUATE_DEPLOYMENT ?? "local");
    console.log("watching health…");
    await onHealthChange(d.executor, async () => { await cycle(); });
    await new Promise(() => {});
    return;
  }
  await cycle();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
