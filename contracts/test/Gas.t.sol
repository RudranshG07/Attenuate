// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {RegistryRolesLib} from "@ensv2/registry/libraries/RegistryRolesLib.sol";

import {AttenuatedSubregistry} from "../src/AttenuatedSubregistry.sol";
import {CapabilityRegistry} from "../src/CapabilityRegistry.sol";
import {Executor} from "../src/Executor.sol";
import {GrantStore} from "../src/GrantStore.sol";
import {SubregistryFactory} from "../src/SubregistryFactory.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockLabelStore} from "../src/mocks/MockLabelStore.sol";
import {MockPool} from "../src/mocks/MockPool.sol";

// Produces the numbers quoted in the README. Run with:
//   forge test --match-contract GasTest -vv
// Every figure below is a gasleft() delta around a single external call, so it includes
// the call overhead a real transaction would also pay.
contract GasTest is Test {
    GrantStore store;

    uint256 deviceKey = 0xA11CE;
    address agent = address(0xA6E7);

    uint256 constant ROOT = 1;
    uint256 constant MANDATE_DEPTH = 8;

    function setUp() public {
        store = new GrantStore(vm.addr(deviceKey));

        GrantStore.RootMandate memory m = GrantStore.RootMandate({
            node: ROOT,
            capabilities: 0xFF,
            spendCap: 10_000 ether,
            queryBudget: 10_000,
            expiry: uint64(block.timestamp + 365 days),
            maxDepth: uint16(MANDATE_DEPTH),
            nonce: 0
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(deviceKey, store.hashMandate(m));
        store.initRoot(m, abi.encodePacked(r, s, v));
    }

    function _registryFor(uint256 node) internal returns (address a) {
        a = address(uint160(uint256(keccak256(abi.encode("registry", node)))));
        if (!store.isRegistry(a)) store.authorizeRegistry(a, node);
    }

    function _grant(uint256 parent, uint256 child, uint16 depth, uint256 cap, uint256 queries) internal {
        GrantStore.Grant memory g;
        g.capabilities = 0x04;
        g.spendCap = cap;
        g.queryBudget = queries;
        g.expiry = uint64(block.timestamp + 1 days);
        g.maxDepth = depth;

        address reg = _registryFor(parent);
        vm.prank(reg);
        store.grantTo(child, agent, g);
    }

    // Builds a chain of `depth` nodes hanging off the root, returning the leaf id.
    // Every level passes its whole budget down, which is what keeps the chain grantable.
    function _chain(uint256 base, uint256 depth) internal returns (uint256 leaf) {
        uint256 parent = ROOT;
        for (uint256 i = 0; i < depth; i++) {
            uint256 child = base + i;
            _grant(parent, child, uint16(MANDATE_DEPTH - i - 1), 1 ether, 1);
            parent = child;
        }
        return parent;
    }

    ////////////////////////////////////////////////////////////////////////
    // Revocation is O(1) in subtree size
    ////////////////////////////////////////////////////////////////////////

    function test_Gas_RevokeIsFlatAcrossSubtreeSizes() public {
        uint256[4] memory widths = [uint256(1), 3, 7, 15];
        uint256[4] memory costs;

        console.log("-- revoke: one storage write, no subtree walk --");

        for (uint256 w = 0; w < widths.length; w++) {
            // Each subtree is a fresh sibling under the root so no two measurements
            // share storage warmth.
            uint256 base = 1000 * (w + 1);
            _grant(ROOT, base, uint16(MANDATE_DEPTH - 1), (widths[w] + 1) * 1 ether, widths[w] + 1);
            for (uint256 i = 0; i < widths[w]; i++) {
                _grant(base, base + 1 + i, uint16(MANDATE_DEPTH - 2), 1 ether, 1);
            }

            address reg = _registryFor(ROOT);
            vm.prank(reg);
            uint256 before = gasleft();
            store.revoke(base);
            costs[w] = before - gasleft();

            console.log("  descendants", widths[w], "gas", costs[w]);
        }

        // A per-descendant walk would add at least one cold SLOAD (2100) per node, so
        // 15 descendants would cost ~31k more than 1. It costs the same.
        assertApproxEqAbs(costs[0], costs[3], 100, "revoke scales with subtree size");
    }

    ////////////////////////////////////////////////////////////////////////
    // Resolution is O(depth), bounded by MAX_WALK
    ////////////////////////////////////////////////////////////////////////

    function test_Gas_IsLiveByDepth() public {
        console.log("-- isLive: cold walk from leaf to root, capped at MAX_WALK --");

        uint256 prev;
        // MAX_WALK hops is the last depth that resolves; the boundary itself is measured
        // by test_Gas_IsLiveIsBoundedPastMaxWalk.
        for (uint256 d = 1; d < MANDATE_DEPTH; d++) {
            // Independent chain per depth, so every walk touches only cold slots.
            uint256 leaf = _chain(100 * d, d);

            uint256 before = gasleft();
            bool live = store.isLive(leaf);
            uint256 cost = before - gasleft();

            assertTrue(live, "chain leaf should be live");
            if (prev != 0) {
                console.log("  depth", d, "gas", cost);
                console.log("    marginal per level", cost - prev);
            } else {
                console.log("  depth", d, "gas", cost);
            }
            prev = cost;
        }

        console.log("  MAX_WALK", store.MAX_WALK());
    }

    function test_Gas_IsLiveIsBoundedPastMaxWalk() public {
        // A chain longer than MAX_WALK cannot cost more to resolve; it fails closed.
        uint256 leaf = _chain(2000, MANDATE_DEPTH);

        uint256 before = gasleft();
        bool live = store.isLive(leaf);
        uint256 atLimit = before - gasleft();

        console.log("-- isLive at the MAX_WALK boundary --");
        console.log("  depth", MANDATE_DEPTH, "gas", atLimit);

        // Past the walk limit liveness is refused rather than assumed, so an attacker
        // cannot bury a grant deep enough to stop the ancestor check from running.
        assertFalse(live, "a chain past MAX_WALK must not resolve as live");
    }

    ////////////////////////////////////////////////////////////////////////
    // Grant, spend and reclaim
    ////////////////////////////////////////////////////////////////////////

    function test_Gas_StoreOperations() public {
        console.log("-- store operations --");

        GrantStore.Grant memory g;
        g.capabilities = 0x04;
        g.spendCap = 1 ether;
        g.queryBudget = 10;
        g.expiry = uint64(block.timestamp + 1 days);
        g.maxDepth = uint16(MANDATE_DEPTH - 1);

        address reg = _registryFor(ROOT);

        vm.prank(reg);
        uint256 before = gasleft();
        store.grantTo(500, agent, g);
        console.log("  grantTo (new child)  ", before - gasleft());

        store.setExecutor(address(this));

        before = gasleft();
        store.spend(500, 0.1 ether);
        console.log("  spend                ", before - gasleft());

        before = gasleft();
        store.spendQuery(500, 1);
        console.log("  spendQuery           ", before - gasleft());

        vm.prank(reg);
        before = gasleft();
        store.revoke(500);
        console.log("  revoke               ", before - gasleft());

        before = gasleft();
        store.reclaim(500);
        console.log("  reclaim              ", before - gasleft());
    }

    ////////////////////////////////////////////////////////////////////////
    // Registry and executor, the paths a real transaction takes
    ////////////////////////////////////////////////////////////////////////

    function test_Gas_RegistryAndExecutor() public {
        MockLabelStore labels = new MockLabelStore();
        SubregistryFactory factory = new SubregistryFactory(labels, store);

        uint256 roles = RegistryRolesLib.ROLE_REGISTRAR | RegistryRolesLib.ROLE_REGISTRAR_ADMIN;
        AttenuatedSubregistry root = new AttenuatedSubregistry(labels, address(this), roles, store, factory);
        store.authorizeRegistry(address(root), ROOT);

        MockERC20 usdc = new MockERC20("Mock USDC", "USDC", 18);
        MockPool pool = new MockPool(usdc);
        CapabilityRegistry caps = new CapabilityRegistry(address(usdc));
        Executor ex = new Executor(store, caps);

        store.setExecutor(address(ex));
        usdc.mint(address(ex), 1000 ether);
        ex.setAllowance(address(usdc), address(pool), type(uint256).max);
        pool.setDebt(address(ex), 500 ether);

        CapabilityRegistry.CapSpec memory repay;
        repay.target = address(pool);
        repay.selector = MockPool.repay.selector;
        repay.amountArgIndex = 1;
        repay.pinnedArgIndex = caps.NO_ARG();
        caps.setCap(2, repay);

        CapabilityRegistry.CapSpec memory read;
        read.target = address(pool);
        read.selector = MockPool.healthFactor.selector;
        read.amountArgIndex = caps.NO_AMOUNT();
        read.queryCost = 1;
        read.readSafe = true;
        read.pinnedArgIndex = caps.NO_ARG();
        caps.setCap(6, read);

        GrantStore.Grant memory g;
        g.capabilities = 0x44;
        g.spendCap = 100 ether;
        g.queryBudget = 100;
        g.expiry = uint64(block.timestamp + 1 days);
        g.maxDepth = 0;

        console.log("-- registry and executor --");

        uint256 before = gasleft();
        uint256 leafNode = root.registerWithGrant("leaf", agent, address(0), g);
        console.log("  registerWithGrant (leaf, no child registry)     ", before - gasleft());

        GrantStore.Grant memory d = g;
        d.capabilities = 0x44 | (1 << 7);
        d.spendCap = 10 ether;
        d.queryBudget = 10;
        d.maxDepth = 2;

        before = gasleft();
        root.registerWithGrant("deleg", agent, address(0), d);
        console.log("  registerWithGrant (delegating, deploys registry)", before - gasleft());

        bytes memory repayData =
            abi.encodeWithSelector(MockPool.repay.selector, address(usdc), 1 ether, uint256(0), address(ex));

        vm.prank(agent);
        before = gasleft();
        ex.execute(leafNode, 2, address(pool), 0, repayData);
        console.log("  execute (ERC20 repay, debits spend budget)      ", before - gasleft());

        bytes memory readData = abi.encodeWithSelector(MockPool.healthFactor.selector, address(ex));

        vm.prank(agent);
        before = gasleft();
        ex.execute(leafNode, 6, address(pool), 0, readData);
        console.log("  execute (paid read, debits query budget)        ", before - gasleft());
    }

    function test_Gas_Deployment() public {
        console.log("-- runtime code size, limit 24576 --");
        console.log("  GrantStore           ", address(store).code.length);

        MockLabelStore labels = new MockLabelStore();
        SubregistryFactory factory = new SubregistryFactory(labels, store);
        console.log("  SubregistryFactory   ", address(factory).code.length);

        uint256 roles = RegistryRolesLib.ROLE_REGISTRAR | RegistryRolesLib.ROLE_REGISTRAR_ADMIN;
        AttenuatedSubregistry reg = new AttenuatedSubregistry(labels, address(this), roles, store, factory);
        console.log("  AttenuatedSubregistry", address(reg).code.length);

        MockERC20 usdc = new MockERC20("Mock USDC", "USDC", 18);
        CapabilityRegistry caps = new CapabilityRegistry(address(usdc));
        console.log("  CapabilityRegistry   ", address(caps).code.length);

        Executor ex = new Executor(store, caps);
        console.log("  Executor             ", address(ex).code.length);
    }
}
