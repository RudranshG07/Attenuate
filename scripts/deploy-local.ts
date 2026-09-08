import { createWalletClient, createPublicClient, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { readFileSync, writeFileSync } from "node:fs";

const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const account = privateKeyToAccount(ANVIL_KEY);
const transport = http("http://127.0.0.1:8545");
const wallet = createWalletClient({ account, chain: foundry, transport });
const pub = createPublicClient({ chain: foundry, transport });

function artifact(name: string) {
  const p = `contracts/out/${name}.sol/${name}.json`;
  const j = JSON.parse(readFileSync(p, "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object as `0x${string}` };
}

async function deploy(name: string, args: unknown[]) {
  const { abi, bytecode } = artifact(name);
  const hash = await wallet.deployContract({ abi, bytecode, args } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (!r.contractAddress) throw new Error(`${name} deploy failed`);
  console.log(`${name.padEnd(22)} ${r.contractAddress}`);
  return r.contractAddress;
}

const store = await deploy("GrantStore", [account.address]);
const caps = await deploy("CapabilityRegistry", ["0x0000000000000000000000000000000000000000"]);
const executor = await deploy("Executor", [store, caps]);

const storeAbi = artifact("GrantStore").abi;
await wallet.writeContract({ address: store, abi: storeAbi, functionName: "setExecutor", args: [executor] });

const out = { chainId: foundry.id, store, caps, executor, device: account.address };
writeFileSync("deployments/local.json", JSON.stringify(out, null, 2));
console.log("\nwrote deployments/local.json");
