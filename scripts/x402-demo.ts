/**
 * A paid data endpoint, answered from the same budget the device authorised.
 *
 * The server here is deliberately real rather than a stub: it refuses with 402 until
 * it is shown a transaction hash, and it checks that hash on chain before serving
 * anything. So the budget is not a counter the client promises to respect — the only
 * way to obtain data is to have spent through `Executor.execute`, which is the same
 * path that governs moving money.
 *
 *   npm run chain && npm run deploy:local
 *   npm run x402
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { loadDeployment, publicClientFor } from "../broker/client.js";
import { agentKey } from "../agent/identity.js";
import { fetchPaid, QueryBudgetExhausted } from "../broker/x402.js";

const AGENT = process.env.X402_AGENT ?? "probe";
const PRICE = 1n;

const d = loadDeployment(process.env.ATTENUATE_DEPLOYMENT ?? "local");
const pub = publicClientFor(d) as never;
const node = BigInt((d as unknown as Record<string, string>)[AGENT]);

// settle() signs as the agent, because Executor refuses anyone else.
process.env.ATTENUATE_PRIVATE_KEY = agentKey(AGENT);

const seen = new Set<string>();

const server = createServer(async (req, res) => {
  const paid = req.headers["x-payment"] as string | undefined;
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (!paid) {
    res.writeHead(402, { "Content-Type": "application/json", "X-Payment-Amount": String(PRICE) });
    return res.end(JSON.stringify({ amount: String(PRICE), resource: "/health" }));
  }

  // A hash is only worth anything once, and only if the chain agrees it happened.
  if (seen.has(paid)) return send(409, { error: "payment already used" });
  const receipt = await pub.getTransactionReceipt({ hash: paid }).catch(() => null);
  if (!receipt || receipt.status !== "success") return send(402, { error: "payment not found" });
  if (receipt.to?.toLowerCase() !== (d.executor as string).toLowerCase()) {
    return send(402, { error: "payment did not go through the executor" });
  }
  seen.add(paid);
  send(200, { healthFactor: "1.30", source: "MockPool", paidWith: paid });
});

async function main() {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/health`;
  console.log(`paid endpoint on ${url}, charging ${PRICE} query unit\n`);

  for (let i = 1; ; i++) {
    try {
      const r = await fetchPaid<{ healthFactor: string }>(url, node);
      console.log(
        `  call ${String(i).padStart(2)}  402 -> paid ${r.paid} -> ${r.data.healthFactor}` +
        `   queryRemaining ${r.queryRemaining}`,
      );
      if (r.queryRemaining === 0n) continue;
    } catch (e) {
      if (e instanceof QueryBudgetExhausted) {
        console.log(`\n  call ${i}  refused: ${e.message}`);
        break;
      }
      throw e;
    }
  }
  server.close();
}

main().catch((e) => { server.close(); console.error(e?.shortMessage ?? e?.message ?? e); process.exit(1); });
