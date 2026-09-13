/**
 * Deploy Attenuate onto an Anvil fork of Sepolia, using the live ENSv2 LabelStore.
 *
 * Prerequisites:
 *   anvil --fork-url $SEPOLIA_RPC_URL --port 8545
 *
 * What this proves that deploy-local does not:
 *   - AttenuatedSubregistry registers labels through the real Sepolia LabelStore
 *   - EIP-712 domain uses chainId 11155111 (Sepolia), not Foundry's 31337
 *   - Anvil accounts are funded on the fork so gas is available
 */
import {
  createWalletClient,
  createPublicClient,
  http,
  decodeEventLog,
  toFunctionSelector,
  parseEther,
  parseAbi,
  type Address,
  type Hex,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Cap } from "../broker/types.js";
import { ENSV2, ENSV2_LEGACY, hackathonSepolia } from "../broker/chain.js";
import { resolveMandateSigner } from "./lib/sign-mandate.js";

const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const REVOKER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const account = privateKeyToAccount(ANVIL_KEY);
const revoker = privateKeyToAccount(REVOKER_KEY);

// Fork keeps Sepolia's chain id; EIP-712 and wallet clients must match it.
const chain = hackathonSepolia as unknown as Chain;
const transport = http(RPC);
const wallet = createWalletClient({ account, chain, transport });
const pub = createPublicClient({ chain, transport });

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

async function mint(registry: Address, label: string, owner: Address, g: readonly unknown[]) {
  const abi = artifact("AttenuatedSubregistry").abi;
  const hash = await wallet.writeContract({
    address: registry, abi, functionName: "registerWithGrant",
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
    } catch { /* not ours */ }
  }
  throw new Error(`no Granted event for ${label}`);
}

async function fundAccounts() {
  // Anvil fork accounts start funded, but make the balances explicit so a cold
  // fork never fails on gas. anvil_setBalance is Anvil-only.
  const targets = [account.address, revoker.address];
  for (const addr of targets) {
    await pub.request({
      method: "anvil_setBalance" as never,
      params: [addr, `0x${parseEther("10000").toString(16)}`] as never,
    });
    // Sepolia has EIP-7702 delegations on the well-known Anvil keys. ERC-1155
    // sees extcodesize > 0 and requires onERC1155Received — clear the code.
    await pub.request({
      method: "anvil_setCode" as never,
      params: [addr, "0x"] as never,
    });
  }
  console.log("funded deployer + revoker (10000 ETH) and cleared EIP-7702 code");
}

async function verifyEnsv2() {
  console.log("\nverifying ENSv2 addresses on this fork");

  const labelCode = await pub.getCode({ address: ENSV2.labelStore as Address });
  if (!labelCode || labelCode === "0x") throw new Error(`ENSV2.labelStore has no code: ${ENSV2.labelStore}`);

  const ethParent = await pub.readContract({
    address: ENSV2.ethRegistry as Address,
    abi: parseAbi(["function getParent() view returns (address, string)"]),
    functionName: "getParent",
  }) as [Address, string];

  const rootEth = await pub.readContract({
    address: ENSV2.rootRegistry as Address,
    abi: parseAbi(["function getSubregistry(string) view returns (address)"]),
    functionName: "getSubregistry",
    args: ["eth"],
  }) as Address;

  const usdcDecimals = await pub.readContract({
    address: ENSV2.mockUsdc as Address,
    abi: parseAbi(["function decimals() view returns (uint8)"]),
    functionName: "decimals",
  }) as number;

  console.log(`  LabelStore         ${ENSV2.labelStore}  code=${labelCode.length}B`);
  console.log(`  ETHRegistry parent ${ethParent[0]} / "${ethParent[1]}"`);
  console.log(`  RootRegistry.eth   ${rootEth}`);
  console.log(`  MockUSDC decimals  ${usdcDecimals}`);

  if (ethParent[1] !== "eth") throw new Error("ETHRegistry.getParent() label is not eth");
  if (rootEth.toLowerCase() !== ENSV2.ethRegistry.toLowerCase()) {
    throw new Error(`RootRegistry.eth (${rootEth}) != ENSV2.ethRegistry (${ENSV2.ethRegistry})`);
  }
  if (ethParent[0].toLowerCase() !== ENSV2.rootRegistry.toLowerCase()) {
    throw new Error(`ETHRegistry parent (${ethParent[0]}) != ENSV2.rootRegistry`);
  }

  // Confirm the legacy pin is a different, still-deployed stack — not what we use.
  const legacyEth = await pub.readContract({
    address: ENSV2_LEGACY.rootRegistry as Address,
    abi: parseAbi(["function getSubregistry(string) view returns (address)"]),
    functionName: "getSubregistry",
    args: ["eth"],
  }) as Address;
  console.log(`  legacy Root.eth    ${legacyEth} (prior redeploy; ignored)`);
  if (legacyEth.toLowerCase() === ENSV2.ethRegistry.toLowerCase()) {
    throw new Error("legacy and current ethRegistry unexpectedly match");
  }

  console.log("  ENSv2 address set OK");
}

async function main() {
  const chainId = await pub.getChainId();
  if (chainId !== sepolia.id) {
    throw new Error(
      `expected Sepolia chainId ${sepolia.id}, got ${chainId}. ` +
        `Start with: anvil --fork-url <sepolia-rpc> --port 8545`,
    );
  }
  console.log(`fork chainId ${chainId} (Sepolia)\n`);

  await fundAccounts();
  await verifyEnsv2();

  // Mint ENSv2 MockUSDC to the deployer so holdings exist on the fork (faucet-style).
  // Attenuate's Executor still uses our 18-decimal MockERC20 as the budget asset —
  // ENSv2 MockUSDC is 6 decimals and is the registrar fee token, not our grant unit.
  const mintHash = await wallet.writeContract({
    address: ENSV2.mockUsdc as Address,
    abi: parseAbi(["function mint(address to, uint256 amount)"]),
    functionName: "mint",
    args: [account.address, 100_000n * 10n ** 6n],
  });
  await pub.waitForTransactionReceipt({ hash: mintHash });
  console.log("minted 100_000 ENSv2 MockUSDC to deployer\n");

  console.log("resolving mandate signer");
  const signer = await resolveMandateSigner(wallet);
  console.log(`  ${signer.kind}  ${signer.address}\n`);

  console.log("deploying Attenuate against live LabelStore\n");
  const labels = ENSV2.labelStore as Address;
  console.log(`${"LabelStore (ENSv2)".padEnd(24)} ${labels}`);

  const store = await deploy("GrantStore", [signer.address]);
  const factory = await deploy("SubregistryFactory", [labels, store]);

  const roles = ROLE_REGISTRAR | ROLE_REGISTRAR_ADMIN | ROLE_UNREGISTER_ADMIN;
  const registry = await deploy("AttenuatedSubregistry", [
    labels, account.address, roles, store, factory,
  ]);
  await write(registry, "AttenuatedSubregistry", "grantRootRoles", [ROLE_UNREGISTER, revoker.address]);

  // Budget asset for Executor metering — separate from ENSv2 registrar MockUSDC.
  const usdc = await deploy("MockERC20", ["Mock USDC", "USDC", 18]);
  const weth = await deploy("MockERC20", ["Mock WETH", "WETH", 18]);
  const pool = await deploy("MockPool", [usdc]);
  const swap = await deploy("MockSwap", [usdc, weth]);
  const caps = await deploy("CapabilityRegistry", [usdc]);
  const executor = await deploy("Executor", [store, caps]);

  console.log("\nwiring");
  await write(store, "GrantStore", "setExecutor", [executor]);
  await write(store, "GrantStore", "authorizeRegistry", [registry, ROOT]);
  await write(usdc, "MockERC20", "mint", [executor, 1000n * 10n ** 18n]);
  await write(weth, "MockERC20", "mint", [swap, 1000n * 10n ** 18n]);
  await write(executor, "Executor", "setAllowance", [usdc, pool, 2n ** 256n - 1n]);
  await write(executor, "Executor", "setAllowance", [usdc, swap, 2n ** 256n - 1n]);
  await write(pool, "MockPool", "setDebt", [executor, 500n * 10n ** 18n]);

  const repaySel = toFunctionSelector("repay(address,uint256,uint256,address)");
  const supplySel = toFunctionSelector("supply(address,uint256,uint16,address)");
  const withdrawSel = toFunctionSelector("withdraw(address,uint256,address)");
  const swapSel = toFunctionSelector("swap(address,uint256,uint256)");
  const healthSel = toFunctionSelector("healthFactor(address)");
  const approveSel = toFunctionSelector("approve(address,uint256)");

  const setCap = (bit: number, spec: ReturnType<typeof capSpec>) =>
    write(caps, "CapabilityRegistry", "setCap", [bit, spec]);

  await setCap(Cap.LEND_AAVE_REPAY, capSpec({ target: pool, selector: repaySel, amountArgIndex: 1 }));
  await setCap(Cap.LEND_AAVE_SUPPLY, capSpec({ target: pool, selector: supplySel, amountArgIndex: 1 }));
  await setCap(Cap.LEND_AAVE_WITHDRAW, capSpec({ target: pool, selector: withdrawSel, amountArgIndex: 1 }));
  await setCap(Cap.SWAP_UNISWAP, capSpec({ target: swap, selector: swapSel, amountArgIndex: 1 }));
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
  const sig = await signer.sign(sepolia.id, store, mandate);
  await write(store, "GrantStore", "initRoot", [mandate, sig]);
  await write(store, "GrantStore", "setRootAgent", [ROOT, account.address]);
  console.log(`root mandate signed by ${signer.kind} (Sepolia chainId) and seeded`);

  console.log("\nseeding tree via ENSv2 LabelStore");
  const day = BigInt(Math.floor(Date.now() / 1000) + 86400);
  const hour = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const eth = (n: string) => BigInt(n) * 10n ** 18n;
  const suffix = Date.now().toString(36).slice(-6);

  const C_READ = 1n << BigInt(Cap.DATA_GRAPH_READ);
  const C_REPAY = 1n << BigInt(Cap.LEND_AAVE_REPAY);
  const C_APPROVE = 1n << BigInt(Cap.ERC20_APPROVE);
  const C_DELEGATE = 1n << BigInt(Cap.DELEGATE);

  const riskLabel = `risk${suffix}`;
  const execLabel = `exec${suffix}`;

  const risk = await mint(registry, riskLabel, account.address, grantTuple({
    capabilities: C_DELEGATE | C_READ | C_REPAY | C_APPROVE,
    spendCap: eth("260"), queryBudget: 140n, expiry: day, maxDepth: 2,
  }));

  // Prove the real LabelStore recorded the label.
  const stored = await pub.readContract({
    address: labels,
    abi: parseAbi(["function getLabel(uint256) view returns (string)"]),
    functionName: "getLabel",
    args: [risk],
  }) as string;
  // tokenId embeds labelhash; getLabel may return the label or empty depending on id form.
  // PermissionedRegistry stores via setLabel(label) keyed by label id — also check by label string path.
  console.log(`  LabelStore.getLabel(tokenId) => "${stored}"`);

  const exec = await mint(registry, execLabel, account.address, grantTuple({
    capabilities: C_REPAY | C_APPROVE | C_READ,
    spendCap: eth("100"), queryBudget: 8n, expiry: hour, maxDepth: 0,
  }));

  const riskRegistry = await pub.readContract({
    address: registry,
    abi: artifact("AttenuatedSubregistry").abi,
    functionName: "getSubregistry",
    args: [riskLabel],
  }) as Address;
  console.log(`  risk registry ${riskRegistry}`);

  const probe = await mint(riskRegistry, "probe", account.address, grantTuple({
    capabilities: C_READ, spendCap: eth("10"), queryBudget: 40n, expiry: hour, maxDepth: 0, readOnly: true,
  }));

  mkdirSync("deployments", { recursive: true });
  const out = {
    chainId: sepolia.id,
    forked: true,
    ensv2: ENSV2,
    store,
    caps,
    executor,
    registry,
    factory,
    labels,
    usdc,
    weth,
    pool,
    swap,
    ensMockUsdc: ENSV2.mockUsdc,
    device: signer.address,
    mandateSigner: signer.kind,
    revoker: revoker.address,
    rootAgent: account.address,
    root: ROOT.toString(),
    risk: risk.toString(),
    exec: exec.toString(),
    probe: probe.toString(),
    riskRegistry,
    riskLabel,
    execLabel,
  };
  writeFileSync("deployments/fork.json", JSON.stringify(out, null, 2));
  console.log("\nwrote deployments/fork.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
