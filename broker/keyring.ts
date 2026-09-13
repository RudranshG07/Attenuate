import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

// Prefer the copy vendored with the project so a fresh clone has it, and let an
// operator point at their own install. Resolved per call rather than at import, so
// setting WALLET_CLI after load still takes effect.
const LOCAL = new URL("../node_modules/.bin/wallet-cli", import.meta.url).pathname;
function bin(): string {
  return process.env.WALLET_CLI ?? (existsSync(LOCAL) ? LOCAL : "wallet-cli");
}

export interface RingOptions {
  key: string;
  pass?: string;
}

interface CliResult {
  ok: boolean;
  data?: unknown;
  error?: { message: string; kind?: string };
}

function env(o?: RingOptions): NodeJS.ProcessEnv {
  return o?.pass ? { ...process.env, WALLET_PASS: o.pass } : process.env;
}

// The CLI prints a "Tip: install the Ledger wallet-cli skill" banner ahead of
// its JSON, so anything before the first brace has to go.
function parse(stdout: string): CliResult {
  const i = stdout.indexOf("{");
  if (i === -1) return { ok: true, data: stdout.trim() };
  try {
    const parsed = JSON.parse(stdout.slice(i)) as Partial<CliResult>;
    // Only an envelope carries `ok`. `ring decrypt` returns the plaintext, and ours is
    // itself JSON, so treating any object as a result would fail every decrypt.
    if (typeof parsed?.ok === "boolean") return parsed as CliResult;
  } catch {
    // not JSON at all
  }
  return { ok: true, data: stdout.trim() };
}

function exec(args: string[], stdin?: string, o?: RingOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(bin(), args, { env: env(o) }, (err, stdout) => {
      const res = parse(stdout ?? "");
      if (!res.ok) return reject(new Error(res.error?.message ?? "wallet-cli failed"));
      if (err && !stdout) return reject(err);
      resolve(stdout ?? "");
    });
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}

export async function listKeys(): Promise<string[]> {
  const out = await exec(["ring", "keys", "--output", "json"]);
  const res = parse(out);
  const d = res.data as { keys?: string[] } | undefined;
  return d?.keys ?? [];
}

export type RingState = "ready" | "uninitialised" | "no-cli";

export interface RingStatus {
  state: RingState;
  keys: string[];
  /** What an operator should do next, in one line. */
  hint: string;
}

/**
 * The three states worth telling apart, because the fix differs for each. A ring is
 * provisioned by `ring init`, which needs a device on the machine; after that the
 * device can be unplugged and encrypt/decrypt restore the trustchain over the network.
 */
export async function ringStatus(): Promise<RingStatus> {
  try {
    const keys = await listKeys();
    return { state: "ready", keys, hint: "" };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (/ENOENT|not found|spawn/i.test(m) && !/Key Ring/i.test(m)) {
      return {
        state: "no-cli",
        keys: [],
        hint: "wallet-cli is not installed. `npm i -D @ledgerhq/wallet-cli`.",
      };
    }
    return {
      state: "uninitialised",
      keys: [],
      hint: "Plug in a Ledger, unlock it, then run `npm run ring init`.",
    };
  }
}

export async function isRingInitialised(): Promise<boolean> {
  return (await ringStatus()).state === "ready";
}

export async function encrypt(plaintext: string, o: RingOptions): Promise<string> {
  const out = await exec(["ring", "encrypt", "--key", o.key], plaintext, o);
  return out.slice(out.indexOf("\n") + 1).trim() || out.trim();
}

export async function decrypt(ciphertext: string, o: RingOptions): Promise<string> {
  const out = await exec(["ring", "decrypt", "--key", o.key], ciphertext, o);
  return out.slice(out.indexOf("\n") + 1).trim() || out.trim();
}

/**
 * A device is reachable when Speculos is pointed at, or when a real one is attached
 * and escalation is explicitly asked for. Without it, a refusal stays a refusal
 * rather than hanging on a prompt nobody can answer.
 */
export function deviceAvailable(): boolean {
  return Boolean(process.env.LEDGER_SPECULOS_URL) || process.env.ATTENUATE_ESCALATE === "1";
}

export interface ApprovalRequest {
  name: string;
  reason: string;
  needed: bigint;
  allowed: bigint;
}

/**
 * Touchpoint 3. An attempt to exceed the mandate surfaces as a device signature
 * prompt rather than a silent revert, so a human decides whether to widen the
 * mandate instead of the agent quietly failing.
 *
 * The counterfactual is the demo: with the device connected this returns; with it
 * unplugged it hangs, which is what makes the hardware load-bearing rather than
 * decorative.
 */
export async function requestApproval(req: ApprovalRequest): Promise<boolean> {
  const { signTypedData } = await import("./device.js");
  const chainId = Number(process.env.ATTENUATE_CHAIN_ID ?? 31337);

  try {
    await signTypedData({
      domain: { name: "Attenuate", version: "1", chainId },
      types: {
        Escalation: [
          { name: "name", type: "string" },
          { name: "reason", type: "string" },
          { name: "needed", type: "uint256" },
          { name: "allowed", type: "uint256" },
        ],
      },
      primaryType: "Escalation",
      message: {
        name: req.name,
        reason: req.reason,
        needed: req.needed.toString(),
        allowed: req.allowed.toString(),
      },
    });
    return true;
  } catch (e) {
    // A rejection on the device is a decision, not a failure. The Ethereum app
    // reports a declined signature as 0x6985 "Condition not satisfied", which reads
    // like a fault and is not one.
    const m = e instanceof Error ? e.message : String(e);
    if (/denied|rejected|refused|6985|condition not satisfied/i.test(m)) return false;
    throw e;
  }
}
