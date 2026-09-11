import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { PublicClient } from "viem";
import { loadDeployment, publicClientFor } from "../broker/client.js";

/**
 * A guard five minutes late is a preference for an app that displays and a bug for
 * one that spends, so this is push-driven and survives restarts and reorgs.
 *
 * Two sources behind one interface:
 *   - Substreams gRPC when SUBSTREAMS_API_TOKEN and SUBSTREAMS_ENDPOINT are set
 *   - the chain's own head otherwise, which is what the local and fork demos use
 *
 * Both persist a cursor and both detect reorgs the same way: by remembering the hash
 * of every block in the confirmation window and noticing when one changes.
 */

export interface TriggerState {
  cursor: string | null;
  lastBlock: string;
  stale: boolean;
  seen: Record<string, string>;
}

export interface Trigger {
  onBlock: (blockNumber: bigint, hash: string) => Promise<void>;
  onUndo: (revertedTo: bigint, droppedHashes: string[]) => Promise<void>;
}

const STATE = process.env.ATTENUATE_CURSOR ?? "deployments/indexer-cursor.json";
const WINDOW = Number(process.env.ATTENUATE_REORG_WINDOW ?? 12);

export function loadState(path = STATE): TriggerState {
  if (!existsSync(path)) return { cursor: null, lastBlock: "0", stale: false, seen: {} };
  return JSON.parse(readFileSync(path, "utf8")) as TriggerState;
}

export function saveState(s: TriggerState, path = STATE): void {
  writeFileSync(path, JSON.stringify(s, null, 2));
}

export function usingSubstreams(): boolean {
  return Boolean(process.env.SUBSTREAMS_API_TOKEN && process.env.SUBSTREAMS_ENDPOINT);
}

/**
 * Compare the hashes we recorded against what the chain now reports. The lowest
 * block whose hash changed is where history diverged.
 */
export function detectReorg(
  state: TriggerState,
  current: Map<bigint, string>,
): { reorged: boolean; revertedTo: bigint; dropped: string[] } {
  const dropped: string[] = [];
  let lowest: bigint | null = null;

  for (const [numStr, hash] of Object.entries(state.seen)) {
    const n = BigInt(numStr);
    const now = current.get(n);
    if (now && now !== hash) {
      dropped.push(hash);
      if (lowest === null || n < lowest) lowest = n;
    }
  }
  return lowest === null
    ? { reorged: false, revertedTo: 0n, dropped: [] }
    : { reorged: true, revertedTo: lowest - 1n, dropped };
}

function prune(seen: Record<string, string>, head: bigint): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(seen)) {
    if (head - BigInt(k) < BigInt(WINDOW)) out[k] = v;
  }
  return out;
}

export async function subscribe(t: Trigger, statePath = STATE): Promise<() => void> {
  if (usingSubstreams()) return subscribeSubstreams(t, statePath);
  return subscribeHead(t, statePath);
}

/** Head-following source. Resumes from the stored cursor after a restart. */
async function subscribeHead(t: Trigger, statePath: string): Promise<() => void> {
  const d = loadDeployment(process.env.ATTENUATE_DEPLOYMENT ?? "local");
  const client = publicClientFor(d) as unknown as PublicClient;
  const state = loadState(statePath);

  const unwatch = client.watchBlockNumber({
    emitOnBegin: true,
    poll: true,
    pollingInterval: Number(process.env.ATTENUATE_POLL_MS ?? 500),
    onBlockNumber: async (head) => {
      // Re-read the confirmation window and compare hashes before trusting the head.
      const current = new Map<bigint, string>();
      const from = head > BigInt(WINDOW) ? head - BigInt(WINDOW) + 1n : 0n;
      for (let n = from; n <= head; n++) {
        const b = await client.getBlock({ blockNumber: n });
        current.set(n, b.hash as string);
      }

      const r = detectReorg(state, current);
      if (r.reorged) {
        state.stale = true;
        state.lastBlock = r.revertedTo.toString();
        state.seen = {};
        saveState(state, statePath);
        await t.onUndo(r.revertedTo, r.dropped);
      }

      for (let n = BigInt(state.lastBlock) + 1n; n <= head; n++) {
        const hash = current.get(n);
        if (!hash) continue;
        state.seen[n.toString()] = hash;
        state.lastBlock = n.toString();
        state.cursor = `head:${n}:${hash}`;
        state.stale = false;
        saveState(state, statePath);
        await t.onBlock(n, hash);
      }

      state.seen = prune(state.seen, head);
      saveState(state, statePath);
    },
  });
  return unwatch;
}

/**
 * Substreams gRPC source. Resumes from the persisted cursor rather than replaying
 * from genesis, and turns BlockUndoSignal into the same onUndo callback.
 */
async function subscribeSubstreams(t: Trigger, statePath: string): Promise<() => void> {
  const state = loadState(statePath);
  const endpoint = process.env.SUBSTREAMS_ENDPOINT!;
  const token = process.env.SUBSTREAMS_API_TOKEN!;
  const pkg = process.env.SUBSTREAMS_PACKAGE;
  if (!pkg) throw new Error("SUBSTREAMS_PACKAGE must point at the .spkg to run");

  const { createRegistry, createRequest, streamBlocks, unpackMapOutput } =
    await import("@substreams/core").catch(() => {
      throw new Error(
        "SUBSTREAMS_API_TOKEN is set but @substreams/core is not installed. " +
          "Run: npm i @substreams/core @substreams/manifest",
      );
    }) as any;

  const { readPackage } = (await import("@substreams/manifest")) as any;
  const substreamPackage = await readPackage(pkg);
  const registry = createRegistry(substreamPackage);

  const request = createRequest({
    substreamPackage,
    outputModule: process.env.SUBSTREAMS_MODULE ?? "map_blocks",
    startBlockNum: BigInt(state.lastBlock),
    startCursor: state.cursor ?? undefined,
    productionMode: true,
  });

  let stop = false;
  (async () => {
    for await (const response of streamBlocks(
      { baseUrl: endpoint, headers: { authorization: `Bearer ${token}` } } as any,
      request,
    )) {
      if (stop) break;
      const message = (response as any).message;

      if (message?.case === "blockUndoSignal") {
        const to = BigInt(message.value.lastValidBlock?.number ?? 0);
        state.stale = true;
        state.lastBlock = to.toString();
        state.cursor = message.value.lastValidCursor ?? state.cursor;
        state.seen = {};
        saveState(state, statePath);
        await t.onUndo(to, []);
        continue;
      }

      if (message?.case === "blockScopedData") {
        const clock = message.value.clock;
        const n = BigInt(clock?.number ?? 0);
        const hash = String(clock?.id ?? "");
        state.seen[n.toString()] = hash;
        state.lastBlock = n.toString();
        state.cursor = message.value.cursor ?? state.cursor;
        state.stale = false;
        saveState(state, statePath);
        unpackMapOutput(response, registry);
        await t.onBlock(n, hash);
      }
    }
  })();

  return () => {
    stop = true;
  };
}
