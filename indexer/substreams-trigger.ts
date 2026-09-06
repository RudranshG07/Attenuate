export interface TriggerState {
  cursor: string | null;
  lastBlock: bigint;
  stale: boolean;
}

export async function subscribe(
  onBlock: (blockNumber: bigint) => Promise<void>,
  onUndo: (revertedTo: bigint) => Promise<void>,
): Promise<void> {
  throw new Error("todo");
}

export async function loadCursor(): Promise<string | null> {
  throw new Error("todo");
}

export async function saveCursor(cursor: string): Promise<void> {
  throw new Error("todo");
}
