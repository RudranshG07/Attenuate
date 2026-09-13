/**
 * The Ledger Key Ring, and what to do about it.
 *
 * `ring init` provisions the trustchain and needs a device on the machine. Everything
 * after that — sealing a scoped capability for a sub-agent, opening it again — works
 * with the device unplugged, because the trustchain restores over the network. So the
 * hardware is needed exactly once, and this command is how you find out where you are.
 *
 *   npm run ring          # where am I
 *   npm run ring init     # provision, with a device plugged in
 *   npm run ring demo     # seal a capability for a sub-agent and open it
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { ringStatus } from "../broker/keyring.js";
import { openCapability, releaseCapability } from "../broker/secrets.js";
import { loadDeployment } from "../broker/client.js";
import { Cap } from "../broker/types.js";

const LOCAL = "node_modules/.bin/wallet-cli";
const BIN = process.env.WALLET_CLI ?? (existsSync(LOCAL) ? LOCAL : "wallet-cli");
const KEY = process.env.RING_KEY ?? "attenuate";

async function status() {
  const s = await ringStatus();
  console.log(`ring: ${s.state}`);
  if (s.state === "ready") {
    console.log(`  keys: ${s.keys.join(", ") || "(none used yet)"}`);
    console.log("  scoped capability release is live. `npm run ring demo`");
    return 0;
  }
  console.log(`  ${s.hint}`);
  if (s.state === "uninitialised") {
    console.log("  Without it the broker falls back to keyring-remote/enroll.ts, which");
    console.log("  seals to an approved ephemeral key instead. Same property, no ring.");
  }
  return 1;
}

async function demo() {
  const s = await ringStatus();
  if (s.state !== "ready") {
    console.error(`ring is ${s.state}. ${s.hint}`);
    process.exit(1);
  }
  const d = loadDeployment(process.env.ATTENUATE_DEPLOYMENT ?? "local");
  const node = BigInt((d as unknown as Record<string, string>).probe ?? d.root);

  // A sub-agent is handed a capability that expires, not a key that does not.
  const cap = await releaseCapability(node, Cap.DATA_GRAPH_READ, 300, { key: KEY });
  console.log(`sealed for node ${String(node).slice(0, 12)}…  expires in 300s`);
  console.log(`  token ${cap.token.slice(0, 48)}…`);

  const opened = await openCapability(cap.token, { key: KEY });
  console.log(`opened: capBit ${opened.capBit}, node matches ${opened.node === node}`);
  console.log("the sub-agent never saw a key, only this.");
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === "init") {
    console.log("running `wallet-cli ring init` — confirm on the device when it asks\n");
    execFileSync(BIN, ["ring", "init", ...process.argv.slice(3)], { stdio: "inherit" });
    return void (await status());
  }
  if (cmd === "demo") return demo();
  process.exit(await status());
}

main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
