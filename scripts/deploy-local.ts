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

const labels = await deploy("MockLabelStore", []);

const ROLE_REGISTRAR = 1n << 0n;
const ROLE_REGISTRAR_ADMIN = ROLE_REGISTRAR << 128n;
const ROLE_SET_RESOLVER = 1n << 24n;
const ROLE_SET_SUBREGISTRY = 1n << 20n;
const roles = ROLE_REGISTRAR | ROLE_REGISTRAR_ADMIN | ROLE_SET_RESOLVER | ROLE_SET_SUBREGISTRY;

const registry = await deploy("AttenuatedSubregistry", [labels, account.address, roles, store]);

const storeAbi = artifact("GrantStore").abi;
await wallet.writeContract({ address: store, abi: storeAbi, functionName: "setExecutor", args: [executor] });

const ROOT = 1n;
await wallet.writeContract({
  address: store, abi: storeAbi, functionName: "authorizeRegistry", args: [registry, ROOT],
});

// The anvil account is the device key, so it can sign its own root mandate.
const mandate = {
  node: ROOT,
  capabilities: 0xffn,
  spendCap: 1000n * 10n ** 18n,
  queryBudget: 1000n,
  expiry: BigInt(Math.floor(Date.now() / 1000) + 30 * 86400),
  maxDepth: 3,
  nonce: 0n,
};
const sig = await wallet.signTypedData({
  domain: { name: "Attenuate", version: "1", chainId: foundry.id, verifyingContract: store },
  types: { RootMandate: [
    { name: "node", type: "uint256" }, { name: "capabilities", type: "uint256" },
    { name: "spendCap", type: "uint256" }, { name: "queryBudget", type: "uint256" },
    { name: "expiry", type: "uint64" }, { name: "maxDepth", type: "uint16" },
    { name: "nonce", type: "uint256" } ] },
  primaryType: "RootMandate",
  message: mandate,
});
await wallet.writeContract({
  address: store, abi: storeAbi, functionName: "initRoot", args: [mandate, sig],
});
console.log("root mandate signed and seeded");

const out = { chainId: foundry.id, store, caps, executor, registry, labels, root: ROOT.toString(), device: account.address };
writeFileSync("deployments/local.json", JSON.stringify(out, null, 2));
console.log("\nwrote deployments/local.json");
