import { execFile } from "node:child_process";

const BIN = process.env.WALLET_CLI ?? "wallet-cli";

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
    return JSON.parse(stdout.slice(i)) as CliResult;
  } catch {
    return { ok: true, data: stdout.trim() };
  }
}

function exec(args: string[], stdin?: string, o?: RingOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(BIN, args, { env: env(o) }, (err, stdout) => {
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

export async function isRingInitialised(): Promise<boolean> {
  try {
    await listKeys();
    return true;
  } catch {
    return false;
  }
}

export async function encrypt(plaintext: string, o: RingOptions): Promise<string> {
  const out = await exec(["ring", "encrypt", "--key", o.key], plaintext, o);
  return out.slice(out.indexOf("\n") + 1).trim() || out.trim();
}

export async function decrypt(ciphertext: string, o: RingOptions): Promise<string> {
  const out = await exec(["ring", "decrypt", "--key", o.key], ciphertext, o);
  return out.slice(out.indexOf("\n") + 1).trim() || out.trim();
}
