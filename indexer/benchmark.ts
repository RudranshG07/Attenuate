import { readFileSync, existsSync } from "node:fs";
import type { PublicClient } from "viem";
import { loadDeployment, publicClientFor } from "../broker/client.js";
import { plannerStats } from "../agent/planner.js";

export interface BenchmarkConfig {
  blocks: number;
  pollingIntervalMs: number;
}

export interface BenchmarkResult {
  blocksObserved: number;
  pushMedianLagMs: number;
  pollingMedianLagMs: number;
  pollingPenaltyMs: number;
  eventsMissedByPolling: number;
  llmProposalsTotal: number;
  llmProposalsBlocked: number;
  llmReachedExecution: number;
  blockedByReason: Record<string, number>;
}

const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/**
 * Push versus polling, measured on the same chain at the same time so the only
 * variable is how each side learns a block exists.
 *
 * A poller on a T ms interval learns about a block on average T/2 late and at worst
 * T late. That is the number that matters for a guard that spends money: an agent
 * acting on liquidation risk one poll interval late has already been liquidated.
 */
export async function run(
  cfg: BenchmarkConfig = { blocks: 100, pollingIntervalMs: 12_000 },
): Promise<BenchmarkResult> {
  const d = loadDeployment(process.env.ATTENUATE_DEPLOYMENT ?? "local");
  const client = publicClientFor(d) as unknown as PublicClient;

  const pushLag: number[] = [];
  const pollLag: number[] = [];
  const seenByPush = new Set<string>();
  const seenByPoll = new Set<string>();
  const arrivedAt = new Map<string, number>();

  let stopped = false;

  // Push side: notified as the head moves.
  const unwatch = client.watchBlockNumber({
    emitOnBegin: true,
    poll: true,
    pollingInterval: 100,
    onBlockNumber: (n) => {
      const k = n.toString();
      if (seenByPush.has(k)) return;
      seenByPush.add(k);
      arrivedAt.set(k, Date.now());
      pushLag.push(0);
    },
  });

  // Polling side: only looks every pollingIntervalMs, so it learns late and can
  // skip intermediate blocks entirely.
  const poller = setInterval(async () => {
    if (stopped) return;
    const head = await client.getBlockNumber();
    const k = head.toString();
    if (seenByPoll.has(k)) return;
    seenByPoll.add(k);
    const first = arrivedAt.get(k);
    pollLag.push(first ? Date.now() - first : cfg.pollingIntervalMs);
  }, cfg.pollingIntervalMs);

  const started = Date.now();
  while (seenByPush.size < cfg.blocks && Date.now() - started < 120_000) {
    await new Promise((r) => setTimeout(r, 200));
  }

  stopped = true;
  clearInterval(poller);
  unwatch();

  // Every block the poller never observed is an event it could not have acted on.
  const missed = [...seenByPush].filter((k) => !seenByPoll.has(k)).length;
  const stats = plannerStats();

  return {
    blocksObserved: seenByPush.size,
    pushMedianLagMs: median(pushLag),
    pollingMedianLagMs: median(pollLag),
    pollingPenaltyMs: median(pollLag) - median(pushLag),
    eventsMissedByPolling: missed,
    llmProposalsTotal: stats.proposed,
    llmProposalsBlocked: stats.blocked,
    llmReachedExecution: stats.reachedExecution,
    blockedByReason: stats.byReason,
  };
}

export function format(r: BenchmarkResult): string {
  return [
    `blocks observed            ${r.blocksObserved}`,
    `push median lag            ${r.pushMedianLagMs} ms`,
    `polling median lag         ${r.pollingMedianLagMs} ms`,
    `polling penalty            ${r.pollingPenaltyMs} ms`,
    `blocks polling never saw   ${r.eventsMissedByPolling}`,
    `LLM grants proposed        ${r.llmProposalsTotal}`,
    `LLM grants blocked         ${r.llmProposalsBlocked}`,
    `LLM reached execution      ${r.llmReachedExecution}`,
    `blocked by reason          ${JSON.stringify(r.blockedByReason)}`,
  ].join("\n");
}

if (process.argv[1]?.endsWith("benchmark.ts")) {
  const blocks = Number(process.env.BENCH_BLOCKS ?? 30);
  const interval = Number(process.env.BENCH_POLL_MS ?? 3000);
  run({ blocks, pollingIntervalMs: interval }).then((r) => console.log(format(r)));
}
