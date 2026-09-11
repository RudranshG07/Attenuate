import { encodePacked, pad, type Address, type Hex, type PublicClient } from "viem";
import { executorAbi, grantStoreAbi } from "./abi.js";
import { loadDeployment, publicClientFor, walletClientFor, type Deployment } from "./client.js";

/**
 * x402: a gated endpoint answers 402 Payment Required, the agent pays, the request
 * is retried.
 *
 * The point is that the payment is debited from Grant.queryRemaining, the same
 * counter the device authorised in the root mandate. There is no separate quota to
 * reconcile: data spend and the human's approval are one object.
 *
 * On-chain, a capability carries a queryCost and Executor.execute calls
 * STORE.spendQuery, so paying for data goes through exactly the same enforcement
 * path as moving money.
 */

export const CAP_GRAPH_READ = 6;

export interface PaymentRequired {
  amount: bigint;
  asset?: string;
  network?: string;
  payTo?: string;
  resource: string;
}

export interface X402Result<T> {
  data: T;
  paid: bigint;
  queryRemaining: bigint;
  txHash?: `0x${string}`;
}

export class QueryBudgetExhausted extends Error {
  constructor(readonly required: bigint, readonly remaining: bigint) {
    super(`OVER_QUERY_BUDGET: needs ${required}, grant has ${remaining}`);
  }
}

/** Parse the 402 body, falling back to the X-Payment-Amount header. */
export function parsePaymentRequired(status: number, headers: Headers, body: unknown): PaymentRequired | null {
  if (status !== 402) return null;
  const b = (body ?? {}) as Record<string, unknown>;
  const fromBody = b.amount ?? b.maxAmountRequired ?? (b.accepts as any)?.[0]?.maxAmountRequired;
  const amount = fromBody ?? headers.get("x-payment-amount") ?? "1";
  return {
    amount: BigInt(String(amount)),
    asset: (b.asset as string) ?? headers.get("x-payment-asset") ?? undefined,
    network: (b.network as string) ?? undefined,
    payTo: (b.payTo as string) ?? undefined,
    resource: (b.resource as string) ?? "",
  };
}

async function queryRemaining(client: PublicClient, d: Deployment, node: bigint): Promise<bigint> {
  const g = (await client.readContract({
    address: d.store, abi: grantStoreAbi, functionName: "grantOf", args: [node],
  })) as { queryRemaining: bigint };
  return g.queryRemaining;
}

/**
 * Settle a 402 by spending from the grant. The debit happens through
 * Executor.execute on the read capability, so it is enforced by the same contract
 * that enforces money, not by a client-side counter we promise to respect.
 */
export async function settle(
  node: bigint,
  required: bigint,
  opts: { deployment?: Deployment; privateKey?: `0x${string}`; callData?: Hex } = {},
): Promise<{ txHash?: `0x${string}`; remaining: bigint }> {
  const d = opts.deployment ?? loadDeployment(process.env.ATTENUATE_DEPLOYMENT ?? "local");
  const client = publicClientFor(d) as unknown as PublicClient;

  const before = await queryRemaining(client, d, node);
  if (before < required) throw new QueryBudgetExhausted(required, before);

  const key = opts.privateKey ?? (process.env.ATTENUATE_PRIVATE_KEY as `0x${string}` | undefined);
  if (!key) {
    // Read-only mode: report what it would cost without sending a transaction.
    return { remaining: before - required };
  }

  const caps = (await client.readContract({
    address: d.caps, abi: (await import("./abi.js")).capabilityRegistryAbi,
    functionName: "caps", args: [CAP_GRAPH_READ],
  })) as { target: Address; selector: `0x${string}`; enabled: boolean };
  if (!caps.enabled) throw new Error("CAP_DISABLED: data.graph.read is not configured");

  // The read capability is pinned to one (target, selector). Callers may supply
  // their own calldata; the default shape is f(address) against the node's agent,
  // which is what the demo's position read looks like.
  const agent = (await client.readContract({
    address: d.store, abi: grantStoreAbi, functionName: "agentOf", args: [node],
  })) as Address;
  const callData =
    opts.callData ?? (encodePacked(["bytes4", "bytes32"], [caps.selector, pad(agent)]) as Hex);

  const w = walletClientFor(d, key);
  const txHash = await w.writeContract({
    address: d.executor, abi: executorAbi, functionName: "execute",
    args: [node, CAP_GRAPH_READ, caps.target, 0n, callData],
  });
  await client.waitForTransactionReceipt({ hash: txHash });

  return { txHash, remaining: await queryRemaining(client, d, node) };
}

/**
 * fetch() that understands 402. Pays from the node's grant and retries once.
 */
export async function fetchPaid<T = unknown>(
  url: string,
  node: bigint,
  init: RequestInit = {},
): Promise<X402Result<T>> {
  const first = await fetch(url, init);
  if (first.status !== 402) {
    return {
      data: (await first.json()) as T,
      paid: 0n,
      queryRemaining: await queryRemaining(
        publicClientFor(loadDeployment(process.env.ATTENUATE_DEPLOYMENT ?? "local")) as unknown as PublicClient,
        loadDeployment(process.env.ATTENUATE_DEPLOYMENT ?? "local"),
        node,
      ),
    };
  }

  const body = await first.json().catch(() => ({}));
  const demand = parsePaymentRequired(402, first.headers, body);
  if (!demand) throw new Error("402 without a parseable payment requirement");

  const { txHash, remaining } = await settle(node, demand.amount);

  const retry = await fetch(url, {
    ...init,
    headers: { ...(init.headers ?? {}), "X-Payment": txHash ?? "dry-run", "X-Payment-Node": node.toString() },
  });
  if (!retry.ok) throw new Error(`paid ${demand.amount} but retry failed: ${retry.status}`);

  return { data: (await retry.json()) as T, paid: demand.amount, queryRemaining: remaining, txHash };
}
