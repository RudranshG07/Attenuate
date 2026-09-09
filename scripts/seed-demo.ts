import { createWalletClient, createPublicClient, http, decodeEventLog, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { readFileSync, writeFileSync } from "node:fs";
import { Cap } from "../broker/types.js";

// Prefer `npm run deploy:local`, which already seeds the demo tree.
// This script re-seeds labels onto an existing deployment if you need a fresh tree
// without redeploying (labels must be unused).

const key = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const account = privateKeyToAccount(key);
const transport = http(process.env.RPC_URL ?? "http://127.0.0.1:8545");
const wallet = createWalletClient({ account, chain: foundry, transport });
const pub = createPublicClient({ chain: foundry, transport });

const art = (n: string) => JSON.parse(readFileSync(`contracts/out/${n}.sol/${n}.json`, "utf8"));
const d = JSON.parse(readFileSync("deployments/local.json", "utf8"));
const registryAbi = art("AttenuatedSubregistry").abi;

const DAY = BigInt(Math.floor(Date.now() / 1000) + 86400);
const HOUR = BigInt(Math.floor(Date.now() / 1000) + 3600);
const eth = (n: string) => BigInt(n) * 10n ** 18n;

function grant(caps: bigint, cap: bigint, query: bigint, expiry: bigint, depth: number, ro: boolean) {
  return [caps, cap, 0n, query, 0n, expiry, depth, ro, false, false, 0n, 0n, 0n] as const;
}

async function mint(registry: Address, label: string, g: readonly unknown[]) {
  const hash = await wallet.writeContract({
    address: registry, abi: registryAbi, functionName: "registerWithGrant",
    args: [label, account.address, account.address, g],
  } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  for (const log of r.logs) {
    try {
      const e = decodeEventLog({ abi: registryAbi, data: log.data, topics: log.topics });
      if (e.eventName === "Granted") {
        const id = (e.args as { tokenId: bigint }).tokenId;
        console.log(`  ${label.padEnd(8)} -> token ${id}`);
        return id;
      }
    } catch {}
  }
  throw new Error(`no Granted event for ${label}`);
}

const suffix = Date.now().toString(36).slice(-4);
console.log(`seeding demo tree (suffix ${suffix})`);

const C_READ = 1n << BigInt(Cap.DATA_GRAPH_READ);
const C_REPAY = 1n << BigInt(Cap.LEND_AAVE_REPAY);
const C_APPROVE = 1n << BigInt(Cap.ERC20_APPROVE);
const C_DELEGATE = 1n << BigInt(Cap.DELEGATE);

const risk = await mint(d.registry, `risk${suffix}`,
  grant(C_DELEGATE | C_READ | C_REPAY | C_APPROVE, eth("260"), 140n, DAY, 2, false));

const exec = await mint(d.registry, `exec${suffix}`,
  grant(C_REPAY | C_APPROVE | C_READ, eth("100"), 8n, HOUR, 0, false));

const riskRegistry = await pub.readContract({
  address: d.registry, abi: registryAbi, functionName: "getSubregistry", args: [`risk${suffix}`],
}) as Address;
console.log(`  risk registry ${riskRegistry}`);

const probe = await mint(riskRegistry, "probe",
  grant(C_READ, eth("10"), 40n, HOUR, 0, true));

writeFileSync("deployments/local.json", JSON.stringify({
  ...d, risk: risk.toString(), exec: exec.toString(), probe: probe.toString(), riskRegistry,
}, null, 2));
console.log("done");
