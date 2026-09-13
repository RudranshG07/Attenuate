import {
  createWalletClient,
  createPublicClient,
  http,
  decodeEventLog,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Cap } from "../broker/types.js";
import { agentAccount, agentAddress } from "../agent/identity.js";

// Anvil account #0 — also the device key that signs the root mandate.
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
// Anvil account #1 — ROLE_UNREGISTER only, so mint and kill stay split.
const REVOKER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

const account = privateKeyToAccount(ANVIL_KEY);
const revoker = privateKeyToAccount(REVOKER_KEY);
const transport = http(process.env.RPC_URL ?? "http://127.0.0.1:8545");
const wallet = createWalletClient({ account, chain: foundry, transport });
const pub = createPublicClient({ chain: foundry, transport });

const ROOT = 1n;
const ROLE_REGISTRAR = 1n << 0n;
const ROLE_REGISTRAR_ADMIN = ROLE_REGISTRAR << 128n;
const ROLE_UNREGISTER = 1n << 12n;
const ROLE_UNREGISTER_ADMIN = ROLE_UNREGISTER << 128n;

const NO_AMOUNT = 0xff;
const NO_ARG = 0xff;

function artifact(name: string) {
  const j = JSON.parse(readFileSync(`contracts/out/${name}.sol/${name}.json`, "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object as Hex };
}

async function deploy(name: string, args: unknown[]): Promise<Address> {
  const { abi, bytecode } = artifact(name);
  const hash = await wallet.deployContract({ abi, bytecode, args } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (!r.contractAddress) throw new Error(`${name} deploy failed`);
  console.log(`${name.padEnd(24)} ${r.contractAddress}`);
  return r.contractAddress;
}

async function write(address: Address, name: string, functionName: string, args: unknown[]) {
  const hash = await wallet.writeContract({
    address, abi: artifact(name).abi, functionName, args,
  } as never);
  await pub.waitForTransactionReceipt({ hash });
}

function capSpec(p: {
  target: Address;
  selector: Hex;
  amountArgIndex: number;
  queryCost?: number;
  readSafe?: boolean;
  pinnedArg?: Address;
  pinnedArgIndex?: number;
}) {
  return {
    target: p.target,
    selector: p.selector,
    amountArgIndex: p.amountArgIndex,
    queryCost: p.queryCost ?? 0,
    readSafe: p.readSafe ?? false,
    enabled: false,
    pinnedArg: p.pinnedArg ?? "0x0000000000000000000000000000000000000000",
    pinnedArgIndex: p.pinnedArgIndex ?? NO_ARG,
  } as const;
}

function grantTuple(p: {
  capabilities: bigint;
  spendCap: bigint;
  queryBudget: bigint;
  expiry: bigint;
  maxDepth: number;
  readOnly?: boolean;
}) {
  return [
    p.capabilities, p.spendCap, 0n, p.queryBudget, 0n,
    p.expiry, p.maxDepth, p.readOnly ?? false, false, false,
    0n, 0n, 0n,
  ] as const;
}

async function mint(
  registry: Address,
  label: string,
  owner: Address,
  g: readonly unknown[],
  as = wallet,
): Promise<bigint> {
  const abi = artifact("AttenuatedSubregistry").abi;
  const hash = await as.writeContract({
    address: registry,
    abi,
    functionName: "registerWithGrant",
    args: [label, owner, owner, g],
  } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  for (const log of r.logs) {
    try {
      const e = decodeEventLog({ abi, data: log.data, topics: log.topics });
      if (e.eventName === "Granted") {
        const id = (e.args as { tokenId: bigint }).tokenId;
        console.log(`  ${label.padEnd(8)} -> token ${id}`);
        return id;
      }
    } catch {
      // not our event
    }
  }
  throw new Error(`no Granted event for ${label}`);
}

async function main() {
  try {
    await pub.getBlockNumber();
  } catch {
    throw new Error("anvil is not reachable at http://127.0.0.1:8545 — run `npm run chain` first");
  }

  console.log("deploying core\n");

  const labels = await deploy("MockLabelStore", []);
  const store = await deploy("GrantStore", [account.address]);
  const factory = await deploy("SubregistryFactory", [labels, store]);

  const roles = ROLE_REGISTRAR | ROLE_REGISTRAR_ADMIN | ROLE_UNREGISTER_ADMIN;
  const registry = await deploy("AttenuatedSubregistry", [
    labels, account.address, roles, store, factory,
  ]);

  await write(registry, "AttenuatedSubregistry", "grantRootRoles", [ROLE_UNREGISTER, revoker.address]);

  const usdc = await deploy("MockERC20", ["Mock USDC", "USDC", 18]);
  const pool = await deploy("MockPool", [usdc]);
  const caps = await deploy("CapabilityRegistry", [usdc]);
  const executor = await deploy("Executor", [store, caps]);

  console.log("\nwiring");
  await write(store, "GrantStore", "setExecutor", [executor]);
  await write(store, "GrantStore", "authorizeRegistry", [registry, ROOT]);

  await write(usdc, "MockERC20", "mint", [executor, 1000n * 10n ** 18n]);
  await write(executor, "Executor", "setAllowance", [usdc, pool, 2n ** 256n - 1n]);
  await write(pool, "MockPool", "setDebt", [executor, 500n * 10n ** 18n]);

  const repaySel = toFunctionSelector("repay(address,uint256,uint256,address)");
  const supplySel = toFunctionSelector("supply(address,uint256,uint16,address)");
  const healthSel = toFunctionSelector("healthFactor(address)");
  const approveSel = toFunctionSelector("approve(address,uint256)");

  const setCap = (bit: number, spec: ReturnType<typeof capSpec>) =>
    write(caps, "CapabilityRegistry", "setCap", [bit, spec]);

  await setCap(Cap.LEND_AAVE_REPAY, capSpec({ target: pool, selector: repaySel, amountArgIndex: 1 }));
  await setCap(Cap.LEND_AAVE_SUPPLY, capSpec({ target: pool, selector: supplySel, amountArgIndex: 1 }));
  await setCap(Cap.SWAP_UNISWAP, capSpec({ target: pool, selector: repaySel, amountArgIndex: 1 }));
  await setCap(Cap.DATA_GRAPH_READ, capSpec({
    target: pool, selector: healthSel, amountArgIndex: NO_AMOUNT, queryCost: 1, readSafe: true,
  }));
  await setCap(Cap.ERC20_APPROVE, capSpec({
    target: usdc, selector: approveSel, amountArgIndex: 1, pinnedArg: pool, pinnedArgIndex: 0,
  }));

  const expiry = BigInt(Math.floor(Date.now() / 1000) + 30 * 86400);
  const mandate = {
    node: ROOT,
    capabilities: 0xffn,
    spendCap: 1000n * 10n ** 18n,
    queryBudget: 1000n,
    expiry,
    maxDepth: 3,
    nonce: 0n,
  };
  const sig = await wallet.signTypedData({
    domain: { name: "Attenuate", version: "1", chainId: foundry.id, verifyingContract: store },
    types: {
      RootMandate: [
        { name: "node", type: "uint256" },
        { name: "capabilities", type: "uint256" },
        { name: "spendCap", type: "uint256" },
        { name: "queryBudget", type: "uint256" },
        { name: "expiry", type: "uint64" },
        { name: "maxDepth", type: "uint16" },
        { name: "nonce", type: "uint256" },
      ],
    },
    primaryType: "RootMandate",
    message: mandate,
  });
  await write(store, "GrantStore", "initRoot", [mandate, sig]);
  await write(store, "GrantStore", "setRootAgent", [ROOT, account.address]);
  console.log("root mandate signed and seeded");

  // Three-level demo tree. CAP_DELEGATE on risk makes the factory deploy its registry.
  console.log("\nseeding demo tree");
  const day = BigInt(Math.floor(Date.now() / 1000) + 86400);
  const hour = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const eth = (n: string) => BigInt(n) * 10n ** 18n;

  const C_READ = 1n << BigInt(Cap.DATA_GRAPH_READ);
  const C_REPAY = 1n << BigInt(Cap.LEND_AAVE_REPAY);
  const C_APPROVE = 1n << BigInt(Cap.ERC20_APPROVE);
  const C_DELEGATE = 1n << BigInt(Cap.DELEGATE);

  // Each name is minted to a key of its own. grantTo sets agentOf to the owner, and
  // Executor refuses anyone else, so these addresses are the agents in the only sense
  // the chain recognises.
  for (const label of ["risk", "exec", "probe"]) {
    await wallet.sendTransaction({ to: agentAddress(label), value: eth("1") } as never);
  }

  const risk = await mint(
    registry,
    "risk",
    agentAddress("risk"),
    grantTuple({
      capabilities: C_DELEGATE | C_READ | C_REPAY | C_APPROVE,
      spendCap: eth("260"),
      queryBudget: 140n,
      expiry: day,
      maxDepth: 2,
    }),
  );

  const exec = await mint(
    registry,
    "exec",
    agentAddress("exec"),
    grantTuple({
      capabilities: C_REPAY | C_APPROVE | C_READ,
      spendCap: eth("100"),
      queryBudget: 8n,
      expiry: hour,
      maxDepth: 0,
    }),
  );

  const riskRegistry = await pub.readContract({
    address: registry,
    abi: artifact("AttenuatedSubregistry").abi,
    functionName: "getSubregistry",
    args: ["risk"],
  }) as Address;
  console.log(`  risk registry ${riskRegistry}`);

  // Minted by risk's own key, not the deployer's. risk is the registrar of the
  // registry under its name, so this is delegation happening rather than being
  // described: the deployer could not mint here if it tried.
  const riskWallet = createWalletClient({
    account: agentAccount("risk"), chain: foundry, transport,
  });

  const probe = await mint(
    riskRegistry,
    "probe",
    agentAddress("probe"),
    grantTuple({
      capabilities: C_READ,
      spendCap: eth("10"),
      queryBudget: 40n,
      expiry: hour,
      maxDepth: 0,
      readOnly: true,
    }),
    riskWallet,
  );

  mkdirSync("deployments", { recursive: true });
  const out = {
    chainId: foundry.id,
    store,
    caps,
    executor,
    registry,
    factory,
    labels,
    usdc,
    pool,
    agents: {
      risk: agentAddress("risk"),
      exec: agentAddress("exec"),
      probe: agentAddress("probe"),
    },
    device: account.address,
    revoker: revoker.address,
    rootAgent: account.address,
    root: ROOT.toString(),
    risk: risk.toString(),
    exec: exec.toString(),
    probe: probe.toString(),
    riskRegistry,
  };
  writeFileSync("deployments/local.json", JSON.stringify(out, null, 2));
  console.log("\nwrote deployments/local.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
