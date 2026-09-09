import { createWalletClient, createPublicClient, http, parseUnits, decodeEventLog } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { readFileSync, writeFileSync } from "node:fs";

const key = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const account = privateKeyToAccount(key);
const transport = http("http://127.0.0.1:8545");
const wallet = createWalletClient({ account, chain: foundry, transport });
const pub = createPublicClient({ chain: foundry, transport });

const art = (n: string) => JSON.parse(readFileSync(`contracts/out/${n}.sol/${n}.json`, "utf8"));
const d = JSON.parse(readFileSync("deployments/local.json", "utf8"));
const registryAbi = art("AttenuatedSubregistry").abi;
const storeAbi = art("GrantStore").abi;

const DAY = BigInt(Math.floor(Date.now() / 1000) + 86400);
const HOUR = BigInt(Math.floor(Date.now() / 1000) + 3600);
const usdc = (n: string) => parseUnits(n, 18);

function grant(caps: bigint, cap: bigint, query: bigint, expiry: bigint, depth: number, ro: boolean) {
  return [caps, cap, 0n, query, 0n, expiry, depth, ro, false, false, 0n, 0n, 0n] as const;
}

async function mint(registry: `0x${string}`, label: string, g: readonly unknown[]) {
  const hash = await wallet.writeContract({
    address: registry, abi: registryAbi, functionName: "registerWithGrant",
    args: [label, account.address, account.address, registry, g],
  });
  const r = await pub.waitForTransactionReceipt({ hash });
  for (const log of r.logs) {
    try {
      const e = decodeEventLog({ abi: registryAbi, data: log.data, topics: log.topics });
      if (e.eventName === "Granted") {
        const id = (e.args as any).tokenId as bigint;
        console.log(`  ${label.padEnd(8)} -> token ${id}`);
        return id;
      }
    } catch {}
  }
  throw new Error(`no Granted event for ${label}`);
}

console.log("seeding demo tree");

// risk: read-only, may delegate further
const risk = await mint(d.registry, "risk",
  grant(0xc0n, usdc("260"), 140n, DAY, 2, true));

// exec: repay only, short lived, leaf
await mint(d.registry, "exec",
  grant(0x04n, usdc("100"), 8n, HOUR, 0, false));

// risk needs its own registry instance to have children of its own
const roles = (1n << 0n) | ((1n << 0n) << 128n) | (1n << 24n) | (1n << 20n);
const dep = await wallet.deployContract({
  abi: registryAbi, bytecode: art("AttenuatedSubregistry").bytecode.object,
  args: [d.labels, account.address, roles, d.store],
} as never);
const riskRegistry = (await pub.waitForTransactionReceipt({ hash: dep })).contractAddress!;
await wallet.writeContract({
  address: d.store, abi: storeAbi, functionName: "authorizeRegistry", args: [riskRegistry, risk],
});
console.log(`  risk registry ${riskRegistry}`);

await mint(riskRegistry, "probe",
  grant(0x40n, usdc("110"), 40n, HOUR, 0, true));

writeFileSync("deployments/local.json", JSON.stringify({ ...d, riskRegistry }, null, 2));
console.log("done");
