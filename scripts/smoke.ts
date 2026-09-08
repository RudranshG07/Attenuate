import { loadDeployment, publicClientFor } from "../broker/client.js";
import { checkScope, decodeCapabilities, newGrant, simulateGrant } from "../broker/grant.js";

const d = loadDeployment("local");
const c = publicClientFor(d) as any;
const ROOT = 1n;
const day = BigInt(Math.floor(Date.now() / 1000) + 86400);

const root = await checkScope(c, d.store, ROOT);
console.log("root:", root.live ? "live" : "dead",
  "| caps:", decodeCapabilities(root.capabilities).length,
  "| remaining:", (root.spendRemaining / 10n ** 18n).toString(), "eth",
  "| maxDepth:", root.maxDepth);

const base = { owner: d.device, resolver: d.device, childRegistry: d.device };

const cases: [string, any][] = [
  ["in scope (repay only, 100)", newGrant({ capabilities: 0x04n, spendCap: 100n * 10n ** 18n, expiry: day, maxDepth: 2 })],
  ["capability parent lacks",    newGrant({ capabilities: 0x1ffn, spendCap: 1n, expiry: day, maxDepth: 2 })],
  ["over parent budget",         newGrant({ capabilities: 0x04n, spendCap: 5000n * 10n ** 18n, expiry: day, maxDepth: 2 })],
  ["expiry beyond parent",       newGrant({ capabilities: 0x04n, spendCap: 1n, expiry: root.expiry + 1n, maxDepth: 2 })],
  ["depth not narrowing",        newGrant({ capabilities: 0x04n, spendCap: 1n, expiry: day, maxDepth: 3 })],
];

for (const [label, grant] of cases) {
  const r = await simulateGrant(c, d.registry!, d.device, { label: "exec", ...base, grant });
  console.log(r.ok ? "  OK   " : "  BLOCK", label.padEnd(28), r.reason ?? "", r.field ? `(${r.field})` : "");
}
