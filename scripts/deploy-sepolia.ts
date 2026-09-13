/**
 * The complete flow, on the hackathon ENSv2 deployment.
 *
 *   1. register attenuate.eth through ETHRegistrar (commit, wait, reveal)
 *   2. deploy a PermissionedResolver proxy through VerifiableFactory
 *   3. deploy Attenuate and point the name's subregistry at AttenuatedSubregistry
 *   4. seed the root from a device-signed EIP-712 mandate
 *   5. mint risk and exec, and publish each grant as text records
 *
 * Run against a fork first:  anvil --fork-url $SEPOLIA_RPC_URL
 * Then against Sepolia:      RPC_URL=$SEPOLIA_RPC_URL LIVE=1 npx tsx scripts/deploy-sepolia.ts
 */
import {
  createPublicClient, createWalletClient, http, decodeEventLog, encodeFunctionData,
  namehash, parseAbi, toFunctionSelector, type Address, type Chain, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";
import { ENSV2, hackathonSepolia } from "../broker/chain.js";
import { Cap } from "../broker/types.js";
import { resolveMandateSigner } from "./lib/sign-mandate.js";

const LIVE = process.env.LIVE === "1";
const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const LABEL = process.env.ROOT_LABEL ?? "attenuate";
const NAME = `${LABEL}.eth`;
const DURATION = 31_536_000n;

const key = (LIVE ? process.env.DEPLOYER_PRIVATE_KEY
                  : "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80") as Hex;
if (!key) throw new Error("DEPLOYER_PRIVATE_KEY is not set");

const account = privateKeyToAccount(key);
const chain = hackathonSepolia as unknown as Chain;
const transport = http(RPC);
const wallet = createWalletClient({ account, chain, transport });
const pub = createPublicClient({ chain, transport });

const art = (n: string) => JSON.parse(readFileSync(`contracts/out/${n}.sol/${n}.json`, "utf8"));

const registrarAbi = parseAbi([
  "function makeCommitment(string label,address owner,bytes32 secret,address subregistry,address resolver,uint64 duration,bytes32 referrer) pure returns (bytes32)",
  "function commit(bytes32 commitment)",
  "function register(string label,address owner,bytes32 secret,address subregistry,address resolver,uint64 duration,address paymentToken,bytes32 referrer) returns (uint256)",
  "function MIN_COMMITMENT_AGE() view returns (uint64)",
  "function rentPriceOracle() view returns (address)",
]);
const oracleAbi = parseAbi([
  "function getRegisterPrice(string label,uint64 available,uint64 duration,address paymentToken) view returns (uint256 base,uint256 premium)",
]);
const erc20Abi = parseAbi([
  "function mint(address to,uint256 amount)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const ethRegistryAbi = parseAbi([
  "function getSubregistry(string label) view returns (address)",
  "function setSubregistry(uint256 anyId,address registry)",
  "function setResolver(uint256 anyId,address resolver)",
  "function findTokenId(string label) view returns (uint256)",
  "function findExpiry(string label) view returns (uint64)",
]);
const factoryAbi = parseAbi(["function deployProxy(address implementation,uint256 salt,bytes data) returns (address)"]);
const resolverAbi = parseAbi([
  "function initialize(address admin,uint256 roleBitmap,bytes[] setters)",
  "function setText(bytes32 node,string key,string value)",
  "function setAddr(bytes32 node,uint256 coinType,bytes value)",
  "function text(bytes32 node,string key) view returns (string)",
  "function multicall(bytes[] calls) returns (bytes[])",
]);

const ROLE_SET_ADDR = 1n << 0n;
const ROLE_SET_TEXT = 1n << 4n;
// EAC keeps a role and its admin 128 bits apart; grant both so the deployer can
// re-delegate record-writing later without redeploying the proxy.
const RESOLVER_ROLES =
  ROLE_SET_ADDR | (ROLE_SET_ADDR << 128n) | ROLE_SET_TEXT | (ROLE_SET_TEXT << 128n);
const NO_AMOUNT = 0xff;
const NO_ARG = 0xff;

const log = (s: string) => console.log(s);
const wait = (h: Hex) => pub.waitForTransactionReceipt({ hash: h });

async function deploy(name: string, args: unknown[]): Promise<Address> {
  const { abi, bytecode } = { abi: art(name).abi, bytecode: art(name).bytecode.object as Hex };
  const h = await wallet.deployContract({ abi, bytecode, args } as never);
  const a = (await wait(h)).contractAddress!;
  log(`  ${name.padEnd(24)} ${a}`);
  return a;
}

async function mineOrWait(seconds: number) {
  if (LIVE) {
    log(`  waiting ${seconds}s for the commitment to age`);
    await new Promise((r) => setTimeout(r, seconds * 1000 + 3000));
  } else {
    await fetch(RPC, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "evm_increaseTime", params: [seconds + 5], id: 1 }),
    });
    await fetch(RPC, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "evm_mine", params: [], id: 1 }),
    });
  }
}

// ---------------------------------------------------------------- 1. the name

async function registerName(): Promise<bigint> {
  // We register with a zero subregistry and wire it afterwards, so presence of a
  // subregistry says nothing about whether the name is ours. Expiry does.
  const taken = await pub.readContract({
    address: ENSV2.ethRegistry as Address, abi: ethRegistryAbi,
    functionName: "findExpiry", args: [LABEL],
  });
  if (taken !== 0n) {
    log(`  ${NAME} already registered, reusing`);
    return tokenIdOf();
  }

  const oracle = await pub.readContract({
    address: ENSV2.ethRegistrar as Address, abi: registrarAbi, functionName: "rentPriceOracle",
  });
  const [base, premium] = await pub.readContract({
    address: oracle, abi: oracleAbi, functionName: "getRegisterPrice",
    args: [LABEL, 31_536_000n, DURATION, ENSV2.mockUsdc as Address],
  });
  const price = base + premium;
  log(`  price ${Number(price) / 1e6} USDC for 1 year`);

  // The registrar computes the premium from the name's own history, so our quote is
  // only indicative. Mint and approve generously rather than guess it exactly.
  const headroom = 1_000_000n * 10n ** 6n;
  await wait(await wallet.writeContract({
    address: ENSV2.mockUsdc as Address, abi: erc20Abi, functionName: "mint",
    args: [account.address, headroom],
  }));
  await wait(await wallet.writeContract({
    address: ENSV2.mockUsdc as Address, abi: erc20Abi, functionName: "approve",
    args: [ENSV2.ethRegistrar as Address, (1n << 256n) - 1n],
  }));
  const bal = await pub.readContract({
    address: ENSV2.mockUsdc as Address, abi: erc20Abi, functionName: "balanceOf", args: [account.address],
  });
  log(`  funded with ${Number(bal) / 1e6} MockUSDC, approved max`);

  const secret = ("0x" + "11".repeat(32)) as Hex;
  const ZERO = "0x0000000000000000000000000000000000000000" as Address;
  const commitment = await pub.readContract({
    address: ENSV2.ethRegistrar as Address, abi: registrarAbi, functionName: "makeCommitment",
    args: [LABEL, account.address, secret, ZERO, ZERO, DURATION, ("0x" + "00".repeat(32)) as Hex],
  });
  await wait(await wallet.writeContract({
    address: ENSV2.ethRegistrar as Address, abi: registrarAbi, functionName: "commit", args: [commitment],
  }));
  log("  committed");

  const minAge = await pub.readContract({
    address: ENSV2.ethRegistrar as Address, abi: registrarAbi, functionName: "MIN_COMMITMENT_AGE",
  });
  await mineOrWait(Number(minAge));

  const h = await wallet.writeContract({
    address: ENSV2.ethRegistrar as Address, abi: registrarAbi, functionName: "register",
    args: [LABEL, account.address, secret, ZERO, ZERO, DURATION, ENSV2.mockUsdc as Address, ("0x" + "00".repeat(32)) as Hex],
  });
  await wait(h);
  log(`  registered ${NAME}`);
  return tokenIdOf();
}

// The registry keys names by a versioned labelhash, which is not the namehash the
// resolver uses for records. Ask the registry rather than recompute it.
function tokenIdOf(): Promise<bigint> {
  return pub.readContract({
    address: ENSV2.ethRegistry as Address, abi: ethRegistryAbi,
    functionName: "findTokenId", args: [LABEL],
  }) as Promise<bigint>;
}

function grantTuple(p: {
  capabilities: bigint; spendCap: bigint; queryBudget: bigint;
  expiry: bigint; maxDepth: number; readOnly?: boolean;
}) {
  return [
    p.capabilities, p.spendCap, 0n, p.queryBudget, 0n,
    p.expiry, p.maxDepth, p.readOnly ?? false, false, false, 0n, 0n, 0n,
  ] as const;
}

function capSpec(p: {
  target: Address; selector: Hex; amountArgIndex: number;
  queryCost?: number; readSafe?: boolean; pinnedArg?: Address; pinnedArgIndex?: number;
}) {
  return {
    target: p.target, selector: p.selector, amountArgIndex: p.amountArgIndex,
    queryCost: p.queryCost ?? 0, readSafe: p.readSafe ?? false, enabled: false,
    pinnedArg: p.pinnedArg ?? "0x0000000000000000000000000000000000000000",
    pinnedArgIndex: p.pinnedArgIndex ?? NO_ARG,
  } as const;
}

async function write(address: Address, name: string, functionName: string, args: unknown[]) {
  await wait(await wallet.writeContract({
    address, abi: art(name).abi, functionName, args,
  } as never));
}

// ---------------------------------------------------------------- main

async function main() {
  log(`chain ${await pub.getChainId()}  deployer ${account.address}  ${LIVE ? "LIVE" : "fork"}`);
  const eth = await pub.getBalance({ address: account.address });
  log(`balance ${Number(eth) / 1e18} ETH\n`);
  if (eth === 0n) throw new Error("deployer has no ETH");

  log("resolving mandate signer");
  const signer = await resolveMandateSigner(wallet);
  log(`  ${signer.kind}  ${signer.address}`);

  const startBlock = Number(await pub.getBlockNumber());
  log(`registering ${NAME}`);
  const tokenId = await registerName();

  log("\ndeploying resolver");
  const initData = encodeFunctionData({
    abi: resolverAbi, functionName: "initialize",
    args: [account.address, RESOLVER_ROLES, []],
  });
  const proxy = await pub.simulateContract({
    account, address: ENSV2.verifiableFactory as Address, abi: factoryAbi,
    functionName: "deployProxy",
    args: [ENSV2.permissionedResolverImpl as Address, BigInt(Date.now()), initData],
  });
  const resolver = proxy.result as Address;
  await wait(await wallet.writeContract(proxy.request));
  log(`  PermissionedResolver     ${resolver}`);

  log("\ndeploying Attenuate");
  const store = await deploy("GrantStore", [signer.address]);
  const usdc = await deploy("MockERC20", ["Budget USDC", "bUSDC", 18]);
  const weth = await deploy("MockERC20", ["Budget WETH", "bWETH", 18]);
  const pool = await deploy("MockPool", [usdc]);
  const swap = await deploy("MockSwap", [usdc, weth]);
  const caps = await deploy("CapabilityRegistry", [usdc]);
  const executor = await deploy("Executor", [store, caps]);
  const factory = await deploy("SubregistryFactory", [ENSV2.labelStore, store]);
  const registry = await deploy("AttenuatedSubregistry", [
    ENSV2.labelStore, account.address,
    (1n << 0n) | (1n << 128n) | (1n << 20n) | (1n << 24n), store, factory,
  ]);

  log("\nwiring the name");
  for (const [fn, to] of [["setSubregistry", registry], ["setResolver", resolver]] as const) {
    await wait(await wallet.writeContract({
      address: ENSV2.ethRegistry as Address, abi: ethRegistryAbi,
      functionName: fn, args: [tokenId, to],
    }));
  }
  log(`  subregistry -> ${registry}`);
  log(`  resolver    -> ${resolver}`);

  log("\nwiring Attenuate");
  await write(store, "GrantStore", "setExecutor", [executor]);
  await write(store, "GrantStore", "authorizeRegistry", [registry, BigInt(namehash(NAME))]);
  await write(usdc, "MockERC20", "mint", [executor, 1000n * 10n ** 18n]);
  await write(weth, "MockERC20", "mint", [swap, 1000n * 10n ** 18n]);
  await write(executor, "Executor", "setAllowance", [usdc, pool, 2n ** 256n - 1n]);
  await write(executor, "Executor", "setAllowance", [usdc, swap, 2n ** 256n - 1n]);
  await write(pool, "MockPool", "setDebt", [executor, 500n * 10n ** 18n]);

  const setCap = (bit: number, spec: ReturnType<typeof capSpec>) =>
    write(caps, "CapabilityRegistry", "setCap", [bit, spec]);
  const repaySel = toFunctionSelector("repay(address,uint256,uint256,address)");
  const supplySel = toFunctionSelector("supply(address,uint256,uint16,address)");
  const withdrawSel = toFunctionSelector("withdraw(address,uint256,address)");
  const swapSel = toFunctionSelector("swap(address,uint256,uint256)");
  const healthSel = toFunctionSelector("healthFactor(address)");
  const approveSel = toFunctionSelector("approve(address,uint256)");
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

  log("\nseeding the root");
  const ROOT = BigInt(namehash(NAME));
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 30 * 86400);
  const mandate = {
    node: ROOT, capabilities: 0xffn, spendCap: 1000n * 10n ** 18n,
    queryBudget: 1000n, expiry, maxDepth: 3, nonce: 0n,
  };
  const sig = await signer.sign(await pub.getChainId(), store, mandate);
  await write(store, "GrantStore", "initRoot", [mandate, sig]);
  await write(store, "GrantStore", "setRootAgent", [ROOT, account.address]);
  log(`  root mandate signed by ${signer.kind} and accepted`);

  log("\nminting the tree");
  // Each child outlives the demo but dies well before its parent, so the tree reads as
  // time-bounded on screen without any node showing up expired.
  const now = Math.floor(Date.now() / 1000);
  const days = (n: number) => BigInt(now + n * 86400);
  const C_READ = 1n << BigInt(Cap.DATA_GRAPH_READ);
  const C_REPAY = 1n << BigInt(Cap.LEND_AAVE_REPAY);
  const C_APPROVE = 1n << BigInt(Cap.ERC20_APPROVE);
  const C_DELEGATE = 1n << BigInt(Cap.DELEGATE);
  const unit = (n: string) => BigInt(n) * 10n ** 18n;

  // GrantStore keys a grant by the token id of the registry that minted it, which is a
  // versioned labelhash and not the namehash the resolver files records under. Carry both.
  const minted: { name: string; key: bigint }[] = [{ name: NAME, key: ROOT }];

  async function mint(reg: Address, label: string, parent: string, g: readonly unknown[]) {
    const abi = art("AttenuatedSubregistry").abi;
    const r = await wait(await wallet.writeContract({
      address: reg, abi, functionName: "registerWithGrant",
      args: [label, account.address, resolver, g],
    } as never));
    for (const l of r.logs) {
      try {
        const e = decodeEventLog({ abi, data: l.data, topics: l.topics });
        if (e.eventName === "Granted") {
          const key = (e.args as { tokenId: bigint }).tokenId;
          minted.push({ name: `${label}.${parent}`, key });
          return key;
        }
      } catch {}
    }
    throw new Error(`no Granted event for ${label}`);
  }

  await mint(registry, "risk", NAME, grantTuple({
    capabilities: C_DELEGATE | C_READ | C_REPAY | C_APPROVE,
    spendCap: unit("260"), queryBudget: 140n, expiry: days(14), maxDepth: 2,
  }));
  await mint(registry, "exec", NAME, grantTuple({
    capabilities: C_REPAY | C_APPROVE | C_READ,
    spendCap: unit("100"), queryBudget: 8n, expiry: days(7), maxDepth: 0,
  }));
  const riskRegistry = await pub.readContract({
    address: registry, abi: art("AttenuatedSubregistry").abi,
    functionName: "getSubregistry", args: ["risk"],
  }) as Address;
  await mint(riskRegistry, "probe", `risk.${NAME}`, grantTuple({
    capabilities: C_READ, spendCap: unit("10"), queryBudget: 40n,
    expiry: days(3), maxDepth: 0, readOnly: true,
  }));
  log(`  risk, exec, probe   (risk registry ${riskRegistry})`);

  log("\npublishing grant records");
  for (const { name, key } of minted) {
    const g = await pub.readContract({
      address: store, abi: art("GrantStore").abi, functionName: "grants", args: [key],
    }) as readonly bigint[];
    const [capabilities, spendCap, spendRemaining, queryBudget, queryRemaining, grantExpiry] = g;
    const node = namehash(name);
    const records: [string, string][] = [
      ["grant.caps", "0x" + capabilities.toString(16)],
      ["grant.cap", spendCap.toString()],
      ["grant.remaining", spendRemaining.toString()],
      ["grant.budget", `${queryRemaining}/${queryBudget}`],
      ["grant.expiry", grantExpiry.toString()],
    ];
    await wait(await wallet.writeContract({
      address: resolver, abi: resolverAbi, functionName: "multicall",
      args: [records.map(([k, v]) =>
        encodeFunctionData({ abi: resolverAbi, functionName: "setText", args: [node, k, v] }))],
    }));
    log(`  ${name.padEnd(24)} caps=${records[0][1]} remaining=${records[2][1]} budget=${records[3][1]}`);
  }

  writeFileSync("deployments/sepolia.json", JSON.stringify({
    chainId: await pub.getChainId(), live: LIVE, name: NAME, startBlock,
    node: namehash(NAME), resolver, store, usdc, weth, pool, swap, caps, executor, factory, registry,
    device: signer.address, mandateSigner: signer.kind,
    deployer: account.address, ensv2: ENSV2,
  }, null, 2));
  log("\nwrote deployments/sepolia.json");
}

main().catch((e) => {
  const data = e?.cause?.data ?? e?.data ?? e?.cause?.cause?.data;
  console.error(e?.shortMessage ?? e?.message ?? e);
  if (data) console.error("revert data:", data);
  process.exit(1);
});
