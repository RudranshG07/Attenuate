// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {GrantStore} from "../src/GrantStore.sol";

contract RevocationTest is Test {
    GrantStore store;

    uint256 deviceKey = 0xA11CE;
    address agent = address(0xA6E7);

    uint256 constant ROOT = 1;

    function setUp() public {
        store = new GrantStore(vm.addr(deviceKey));
        _initRoot();
    }

    function _initRoot() internal {
        GrantStore.RootMandate memory m = GrantStore.RootMandate({
            node: ROOT,
            capabilities: 0xFF,
            spendCap: 1000 ether,
            queryBudget: 1000,
            expiry: uint64(block.timestamp + 30 days),
            maxDepth: 6,
            nonce: 0
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(deviceKey, store.hashMandate(m));
        store.initRoot(m, abi.encodePacked(r, s, v));
    }

    function _registryFor(uint256 node) internal returns (address a) {
        a = address(uint160(0x1000 + node));
        store.authorizeRegistry(a, node);
    }

    function _grant(uint256 parent, uint256 child, uint256 cap, uint16 depth) internal {
        address reg = _registryFor(parent);
        GrantStore.Grant memory g;
        g.capabilities = 0x04;
        g.spendCap = cap;
        g.queryBudget = 1;
        g.expiry = uint64(block.timestamp + 1 days);
        g.maxDepth = depth;
        vm.prank(reg);
        store.grantTo(child, agent, g);
    }

    function _chain(uint256 depth) internal {
        uint256 parent = ROOT;
        uint16 d = 5;
        for (uint256 i = 0; i < depth; i++) {
            _grant(parent, parent + 1, 10 ether, d);
            parent += 1;
            d -= 1;
        }
    }

    function test_RootRevocationKillsWholeSubtreeSameBlock() public {
        _chain(3);

        assertTrue(store.isLive(2));
        assertTrue(store.isLive(3));
        assertTrue(store.isLive(4));

        uint256 blockBefore = block.number;
        store.revoke(ROOT);

        assertEq(block.number, blockBefore);
        assertFalse(store.isLive(ROOT));
        assertFalse(store.isLive(2));
        assertFalse(store.isLive(3));
        assertFalse(store.isLive(4));
    }

    function test_RevokeGasIsConstantRegardlessOfSubtreeSize() public {
        // Two sibling subtrees. Both roots-of-subtree have had their storage
        // written exactly twice (granted, then debited for a child), so the
        // comparison isolates subtree size from cold/warm storage cost.
        // A throwaway revoke first, so the shared `owner` slot is warm and the
        // two measurements below differ only by subtree size.
        _grant(ROOT, 10, 100 ether, 4);
        _grant(10, 11, 1 ether, 3);

        _grant(ROOT, 20, 100 ether, 4);
        _grant(20, 21, 10 ether, 3);
        _grant(21, 22, 5 ether, 2);
        _grant(22, 23, 1 ether, 1);

        _grant(ROOT, 30, 1 ether, 4);
        store.revoke(30);

        assertTrue(store.isLive(11));
        assertTrue(store.isLive(23));

        uint256 gSmall = gasleft();
        store.revoke(10);
        gSmall = gSmall - gasleft();

        uint256 gLarge = gasleft();
        store.revoke(20);
        gLarge = gLarge - gasleft();

        assertFalse(store.isLive(11));
        assertFalse(store.isLive(23));

        // Tolerance far below the cost of touching one extra node, so any per-descendant
        // work would fail this even though compiler noise will not.
        assertApproxEqAbs(gSmall, gLarge, 100, "revoke gas must not depend on subtree size");
        emit log_named_uint("revoke gas (1 descendant)", gSmall);
        emit log_named_uint("revoke gas (3 descendants)", gLarge);
    }

    function test_MidTreeRevokeOrphansOnlyItsOwnSubtree() public {
        _chain(3);

        store.revoke(3);

        assertTrue(store.isLive(ROOT));
        assertTrue(store.isLive(2));
        assertFalse(store.isLive(3));
        assertFalse(store.isLive(4));
    }

    function test_ReclaimSweepsDeadSubtreeToNearestLiveAncestor() public {
        _chain(2);
        assertEq(store.grantOf(ROOT).spendRemaining, 990 ether);

        store.revoke(2);
        store.reclaim(3);
        store.reclaim(2);

        assertEq(store.grantOf(ROOT).spendRemaining, 1000 ether);
        assertEq(store.grantOf(2).spendRemaining, 0);
        assertEq(store.grantOf(3).spendRemaining, 0);
    }

    function test_DoubleRevokeReverts() public {
        _chain(1);
        store.revoke(2);
        vm.expectRevert("ALREADY_REVOKED");
        store.revoke(2);
    }

    function test_ReclaimOnLiveNodeReverts() public {
        _chain(1);
        vm.expectRevert("STILL_LIVE");
        store.reclaim(2);
    }

    function test_DoubleReclaimReverts() public {
        _chain(1);
        store.revoke(2);
        store.reclaim(2);
        vm.expectRevert("ALREADY_RECLAIMED");
        store.reclaim(2);
    }

    function test_ExpiredNodeIsNotLive() public {
        _chain(1);
        assertTrue(store.isLive(2));
        vm.warp(block.timestamp + 2 days);
        assertFalse(store.isLive(2));
    }

    function test_IsLiveFailsClosedPastMaxWalk() public {
        _chain(5);
        assertTrue(store.isLive(6));

        for (uint256 n = 7; n <= 12; n++) {
            address reg = _registryFor(n - 1);
            GrantStore.Grant memory g;
            g.capabilities = 0x04;
            g.spendCap = 1;
            g.expiry = uint64(block.timestamp + 1 days);
            g.maxDepth = 0;
            vm.prank(reg);
            try store.grantTo(n, agent, g) {} catch {}
        }

        assertFalse(store.isLive(12));
    }

    function test_GrantUnderRevokedParentReverts() public {
        _chain(1);
        store.revoke(2);

        address reg = _registryFor(2);
        GrantStore.Grant memory g;
        g.capabilities = 0x04;
        g.spendCap = 1 ether;
        g.expiry = uint64(block.timestamp + 1 hours);
        g.maxDepth = 0;

        vm.prank(reg);
        vm.expectRevert("PARENT_DEAD");
        store.grantTo(3, agent, g);
    }
}
