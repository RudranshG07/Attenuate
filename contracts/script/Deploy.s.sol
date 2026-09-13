// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {RegistryRolesLib} from "@ensv2/registry/libraries/RegistryRolesLib.sol";

import {AttenuatedSubregistry} from "../src/AttenuatedSubregistry.sol";
import {CapabilityRegistry} from "../src/CapabilityRegistry.sol";
import {Executor} from "../src/Executor.sol";
import {GrantStore} from "../src/GrantStore.sol";
import {SubregistryFactory} from "../src/SubregistryFactory.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockLabelStore} from "../src/mocks/MockLabelStore.sol";
import {MockPool} from "../src/mocks/MockPool.sol";
import {MockSwap} from "../src/mocks/MockSwap.sol";

// Local / anvil deploy in the order the contracts require:
//   LabelStore → GrantStore → Factory → root registry → mock asset + pool →
//   CapabilityRegistry → Executor → wire → EIP-712 root mandate → setRootAgent.
// Child registries are not deployed here: CAP_DELEGATE grants create them via the factory.
contract Deploy is Script {
    uint256 constant ROOT = 1;

    uint8 constant SWAP = 0;
    uint8 constant SUPPLY = 1;
    uint8 constant REPAY = 2;
    uint8 constant WITHDRAW = 3;
    uint8 constant APPROVE = 4;
    uint8 constant READ = 6;

    struct Addrs {
        address labels;
        address store;
        address factory;
        address registry;
        address usdc;
        address weth;
        address pool;
        address swap;
        address caps;
        address executor;
    }

    function run() external {
        uint256 pk =
            vm.envOr("PRIVATE_KEY", uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80));
        address deployer = vm.addr(pk);
        address revoker = vm.envOr("REVOKER", deployer);
        address rootAgent = vm.envOr("ROOT_AGENT", deployer);

        vm.startBroadcast(pk);
        Addrs memory a = _deploy(deployer, revoker);
        _wire(a);
        _seedRoot(GrantStore(a.store), pk, rootAgent);
        vm.stopBroadcast();

        _log(a, deployer, revoker, rootAgent);
    }

    function _deploy(address deployer, address revoker) internal returns (Addrs memory a) {
        uint256 roles = RegistryRolesLib.ROLE_REGISTRAR | RegistryRolesLib.ROLE_REGISTRAR_ADMIN
            | RegistryRolesLib.ROLE_UNREGISTER_ADMIN;

        MockLabelStore labels = new MockLabelStore();
        GrantStore store = new GrantStore(deployer);
        SubregistryFactory factory = new SubregistryFactory(labels, store);
        AttenuatedSubregistry registry = new AttenuatedSubregistry(labels, deployer, roles, store, factory);
        registry.grantRootRoles(RegistryRolesLib.ROLE_UNREGISTER, revoker);

        MockERC20 usdc = new MockERC20("Mock USDC", "USDC", 18);
        MockERC20 weth = new MockERC20("Mock WETH", "WETH", 18);
        MockPool pool = new MockPool(usdc);
        MockSwap swapper = new MockSwap(usdc, weth);
        CapabilityRegistry caps = new CapabilityRegistry(address(usdc));
        Executor executor = new Executor(store, caps);

        a.labels = address(labels);
        a.store = address(store);
        a.factory = address(factory);
        a.registry = address(registry);
        a.usdc = address(usdc);
        a.weth = address(weth);
        a.pool = address(pool);
        a.swap = address(swapper);
        a.caps = address(caps);
        a.executor = address(executor);
    }

    function _wire(Addrs memory a) internal {
        GrantStore store = GrantStore(a.store);
        Executor executor = Executor(payable(a.executor));
        MockERC20 usdc = MockERC20(a.usdc);
        MockERC20 weth = MockERC20(a.weth);
        MockPool pool = MockPool(a.pool);

        store.setExecutor(a.executor);
        store.authorizeRegistry(a.registry, ROOT);

        usdc.mint(a.executor, 1000 ether);
        weth.mint(a.swap, 1000 ether);
        executor.setAllowance(a.usdc, a.pool, type(uint256).max);
        executor.setAllowance(a.usdc, a.swap, type(uint256).max);
        pool.setDebt(a.executor, 500 ether);

        _configureCaps(CapabilityRegistry(a.caps), usdc, pool, MockSwap(a.swap));
    }

    function _seedRoot(GrantStore store, uint256 pk, address rootAgent) internal {
        GrantStore.RootMandate memory m = GrantStore.RootMandate({
            node: ROOT,
            capabilities: 0xFF,
            spendCap: 1000 ether,
            queryBudget: 1000,
            expiry: uint64(block.timestamp + 30 days),
            maxDepth: 3,
            nonce: 0
        });
        bytes32 digest = store.hashMandate(m);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        store.initRoot(m, abi.encodePacked(r, s, v));
        store.setRootAgent(ROOT, rootAgent);
    }

    function _configureCaps(CapabilityRegistry caps, MockERC20 usdc, MockPool pool, MockSwap swapper)
        internal
    {
        caps.setCap(REPAY, _spend(address(pool), MockPool.repay.selector));
        caps.setCap(SUPPLY, _spend(address(pool), MockPool.supply.selector));
        caps.setCap(WITHDRAW, _spend(address(pool), MockPool.withdraw.selector));
        caps.setCap(SWAP, _spend(address(swapper), MockSwap.swap.selector));

        CapabilityRegistry.CapSpec memory read;
        read.target = address(pool);
        read.selector = MockPool.healthFactor.selector;
        read.amountArgIndex = caps.NO_AMOUNT();
        read.queryCost = 1;
        read.readSafe = true;
        read.pinnedArgIndex = caps.NO_ARG();
        caps.setCap(READ, read);

        CapabilityRegistry.CapSpec memory approve;
        approve.target = address(usdc);
        approve.selector = MockERC20.approve.selector;
        approve.amountArgIndex = 1;
        approve.pinnedArg = address(pool);
        approve.pinnedArgIndex = 0;
        caps.setCap(APPROVE, approve);
    }

    function _spend(address target, bytes4 selector) internal pure returns (CapabilityRegistry.CapSpec memory s) {
        s.target = target;
        s.selector = selector;
        s.amountArgIndex = 1;
        s.pinnedArgIndex = 0xFF;
    }

    function _log(Addrs memory a, address device, address revoker, address rootAgent) internal pure {
        console2.log("labels", a.labels);
        console2.log("store", a.store);
        console2.log("factory", a.factory);
        console2.log("registry", a.registry);
        console2.log("usdc", a.usdc);
        console2.log("weth", a.weth);
        console2.log("pool", a.pool);
        console2.log("swap", a.swap);
        console2.log("caps", a.caps);
        console2.log("executor", a.executor);
        console2.log("device", device);
        console2.log("revoker", revoker);
        console2.log("rootAgent", rootAgent);
        console2.log("root", ROOT);
    }
}
