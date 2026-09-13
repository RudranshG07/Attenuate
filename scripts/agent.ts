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
import { agentAddress, agentKey } from "../agent/identity.js";
import { onHealthChange, readPosition } from "../agent/monitor.js";
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

const poolAbi = parseAbi([
  "function repay(address asset, uint256 amount, uint256 rate, address onBehalfOf) returns (uint256)",
]);

/**
 * A sub-agent signs with the key for its own name; only the root falls back to the
 * broker. Executor checks `msg.sender == STORE.agentOf(node)`, so a process running as
 * a name it does not hold is refused on chain rather than by convention.
 */
function keyFor(name: string | undefined): `0x${string}` {
  if (name) return agentKey(name);
  return (process.env.ATTENUATE_PRIVATE_KEY ?? process.env.BROKER_KEY ?? ANVIL_KEY) as `0x${string}`;
}

/**
 * The name, the key and the node have to agree or the process is claiming to be
 * something it is not. An explicit node wins; otherwise the name selects it, and only
 * an unnamed run falls back to a default.
 */
function nodeFromEnv(d: Record<string, unknown>, named: string | undefined): bigint {
  if (process.env.ATTENUATE_AGENT_NODE) return BigInt(process.env.ATTENUATE_AGENT_NODE);
  if (named) {
    const id = d[named];
    if (typeof id !== "string") throw new Error(`no node recorded for ${named}`);
    return BigInt(id);
  }
  return BigInt((d.exec ?? d.root) as string);
}

async function grantOf(store: Address, node: bigint, pub: ReturnType<typeof publicClientFor>): Promise<Grant> {
  return (await pub.readContract({
    address: store, abi: grantStoreAbi, functionName: "grantOf", args: [node],
  })) as Grant;
}

const REFUSALS = [
  "OVER_BUDGET", "CAP_MISSING", "OVER_QUERY_BUDGET", "READ_ONLY",
  "REVOKED_OR_EXPIRED", "NOT_AGENT", "CAP_DISABLED",
];

async function cycle() {
  const d = loadDeployment(process.env.ATTENUATE_DEPLOYMENT ?? "local");
  const pub = publicClientFor(d);
  const named = process.env.ATTENUATE_AGENT_NAME;
  const node = nodeFromEnv(d as unknown as Record<string, unknown>, named);
  const name = named ?? `node-${node}`;
  const wallet = walletClientFor(d, keyFor(named));

  const grant = await grantOf(d.store, node, pub);
  if (grant.epoch === 0n) throw new Error(`no grant at node ${node}`);

  // Printed every cycle because it is the claim: this process, this key, this name.
  const holder = (await pub.readContract({
    address: d.store, abi: grantStoreAbi, functionName: "agentOf", args: [node],
  })) as Address;
  const holds = holder.toLowerCase() === wallet.account.address.toLowerCase();

  // An unfunded sender fails gas estimation before any permission check runs, which
  // looks like a refusal and is not one. Say so rather than let it read as enforcement.
  if ((await pub.getBalance({ address: wallet.account.address })) === 0n) {
    console.error(
      `${name}: ${wallet.account.address} holds no ETH, so nothing it sends can be ` +
      `mined. Fund it before reading anything into the result.`,
    );
    process.exit(1);
  }
  console.log(
    `${name}  pid ${process.pid}  key ${wallet.account.address}  agentOf ${holder}  holds ${holds}`,
  );

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
      // Minted to the child's own key, so the process spawned below is the only
      // thing that can spend under this name.
      args: [label, agentAddress(label), agentAddress(label), tuple(child)],
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

    // The child signs its own transactions, so it needs gas of its own. A parent that
    // delegates authority and withholds the means to use it has delegated nothing.
    const fee = await pub.getBalance({ address: agentAddress(label) });
    if (fee === 0n) {
      const funded = await wallet.sendTransaction({ to: agentAddress(label), value: 10n ** 17n });
      await pub.waitForTransactionReceipt({ hash: funded });
      console.log(`  funded ${label} with 0.1 ETH for its own gas`);
    }
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
    // Which refusal it is depends on the leaf: a leaf with budget left but not enough
    // gets OVER_BUDGET, a read-only one never had the capability to begin with. Both
    // are the chain refusing, which is the point; anything else is a real failure.
    const msg = e instanceof Error ? e.message : String(e);
    const refusal = REFUSALS.find((r) => msg.includes(r));
    if (!refusal) throw e;
    console.log(`  escalate refused on-chain  ${refusal}`);
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
