export interface BenchmarkResult {
  blocksObserved: number;
  substreamsMedianLagMs: number;
  pollingMedianLagMs: number;
  eventsMissedByPolling: number;
  llmProposalsTotal: number;
  llmProposalsBlocked: number;
}

export async function run(blocks = 100): Promise<BenchmarkResult> {
  throw new Error("todo");
}
