/**
 * Reorg recovery against a reorg that actually happened.
 *
 * A guard that acts on rolled-back state is worse than one that waits, so the claim
 * worth making is not "we handle reorgs" but "we detected this one and resumed at the
 * right block". Anvil can rewrite its own history, so the reorg here is forced rather
 * than simulated: `anvil_reorg` drops N blocks and the trigger has to notice on its
 * own, from block hashes it recorded before the drop.
 *
 *   npm run chain && npm run deploy:local
 *   npm run reorg
 */
import { rmSync } from "node:fs";
import { loadDeployment, publicClientFor } from "../broker/client.js";
import { loadState, subscribe, usingSubstreams } from "../indexer/substreams-trigger.js";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const STATE = process.env.ATTENUATE_CURSOR ?? "deployments/indexer-cursor.json";
const DEPTH = Number(process.env.REORG_DEPTH ?? 3);

const d = loadDeployment(process.env.ATTENUATE_DEPLOYMENT ?? "local");
const pub = publicClientFor(d) as never;

async function rpc(method: string, params: unknown[]) {
  const r = await fetch(RPC, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = (await r.json()) as { error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  rmSync(STATE, { force: true });
  console.log(`source: ${usingSubstreams() ? "substreams gRPC" : "chain head"}\n`);

  let seen = 0;
  let undo: { revertedTo: bigint; dropped: number } | null = null;

  const unwatch = await subscribe({
    async onBlock(n) { seen++; void n; },
    async onUndo(revertedTo, dropped) {
      undo = { revertedTo, dropped: dropped.length };
      console.log(`  undo callback: revertedTo=${revertedTo}, ${dropped.length} hashes dropped`);
    },
  });

  for (let i = 0; i < 15; i++) { await rpc("evm_mine", []); await wait(60); }
  await wait(1200);
  const before = loadState(STATE);
  console.log(`  blocks seen ${seen}, cursor persisted at ${before.lastBlock}`);

  // anvil_reorg takes (depth, txBlockPairs); we only want blocks dropped.
  await rpc("anvil_reorg", [DEPTH, []]);
  console.log(`  anvil_reorg depth ${DEPTH} applied`);

  for (let i = 0; i < 6; i++) { await rpc("evm_mine", []); await wait(60); }
  await wait(2500);

  const after = loadState(STATE);
  const head = await pub.getBlockNumber();
  unwatch();

  if (!undo) {
    console.error("\nFAILED: the reorg went unnoticed");
    process.exit(1);
  }
  console.log(`  stale flag ${after.stale ? "still set" : "cleared"}, resumed at ${after.lastBlock}`);
  console.log(`\nchain head ${head}, cursor ${after.lastBlock}`);
  if (after.stale || BigInt(after.lastBlock) !== head) {
    console.error("FAILED: did not resume cleanly at the new head");
    process.exit(1);
  }
  console.log("recovered");
}

main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
