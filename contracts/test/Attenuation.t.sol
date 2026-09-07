// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {GrantStore} from "../src/GrantStore.sol";

contract Harness is GrantStore {
    constructor(address device) GrantStore(device) {}

    function exposed(Grant memory p, Grant memory c) external pure {
        _assertAttenuated(p, c);
    }
}

contract AttenuationTest is Test {
    Harness h;

    uint256 constant ROOT = 1;
    uint256 constant CHILD = 2;
    uint256 constant GRANDCHILD = 3;

    address registry = address(0xBEEF);
    address childRegistry = address(0xCAFE);

    uint256 deviceKey = 0xA11CE;
    address device;

    function setUp() public {
        device = vm.addr(deviceKey);
        h = new Harness(device);
        h.authorizeRegistry(registry, ROOT);
        h.authorizeRegistry(childRegistry, CHILD);
        _signRoot(deviceKey);
    }

    function _mandate() internal view returns (GrantStore.RootMandate memory m) {
        m.node = ROOT;
        m.capabilities = 0xFF;
        m.spendCap = 1000 ether;
        m.queryBudget = 1000;
        m.expiry = uint64(block.timestamp + 30 days);
        m.maxDepth = 3;
        m.nonce = 0;
    }

    function _signRoot(uint256 key) internal {
        GrantStore.RootMandate memory m = _mandate();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, h.hashMandate(m));
        h.initRoot(m, abi.encodePacked(r, s, v));
    }

    function _child(uint256 cap, uint256 budget, uint16 depth)
        internal
        view
        returns (GrantStore.Grant memory g)
    {
        g.capabilities = 0x04;
        g.spendCap = cap;
        g.queryBudget = budget;
        g.expiry = uint64(block.timestamp + 1 days);
        g.maxDepth = depth;
    }

    function testFuzz_RejectsAnythingNotAttenuated(
        GrantStore.Grant memory p,
        GrantStore.Grant memory c
    ) public view {
        try h.exposed(p, c) {
            assertEq(c.capabilities & p.capabilities, c.capabilities);
            assertLe(c.spendCap, p.spendRemaining);
            assertLe(c.queryBudget, p.queryRemaining);
            assertLe(c.expiry, p.expiry);
            assertLt(c.maxDepth, p.maxDepth);
            if (p.readOnly) assertTrue(c.readOnly);
        } catch {}
    }

    function testFuzz_AcceptsWhenGenuinelyNarrower(
        GrantStore.Grant memory p,
        GrantStore.Grant memory c
    ) public view {
        vm.assume(p.maxDepth > 0);

        c.capabilities = c.capabilities & p.capabilities;
        c.spendCap = bound(c.spendCap, 0, p.spendRemaining);
        c.queryBudget = bound(c.queryBudget, 0, p.queryRemaining);
        c.expiry = uint64(bound(c.expiry, 0, p.expiry));
        c.maxDepth = uint16(bound(c.maxDepth, 0, uint256(p.maxDepth) - 1));
        if (p.readOnly) c.readOnly = true;

        h.exposed(p, c);
    }

    function test_AllocationDebitsParentImmediately() public {
        vm.prank(registry);
        h.grantTo(CHILD, _child(400 ether, 300, 2));

        GrantStore.Grant memory p = h.grantOf(ROOT);
        assertEq(p.spendRemaining, 600 ether);
        assertEq(p.queryRemaining, 700);
        assertEq(p.spendCap, 1000 ether);

        GrantStore.Grant memory c = h.grantOf(CHILD);
        assertEq(c.spendRemaining, 400 ether);
        assertEq(c.queryRemaining, 300);
    }

    function test_SecondChildCannotTakeAlreadyAllocatedBudget() public {
        vm.prank(registry);
        h.grantTo(CHILD, _child(1000 ether, 0, 2));

        vm.prank(registry);
        vm.expectRevert("CAP_EXCEEDS_UNALLOCATED");
        h.grantTo(GRANDCHILD, _child(1 ether, 0, 2));
    }

    function test_SecondChildCannotTakeAlreadyAllocatedQueryBudget() public {
        vm.prank(registry);
        h.grantTo(CHILD, _child(0, 1000, 2));

        vm.prank(registry);
        vm.expectRevert("BUDGET_EXCEEDS_UNALLOCATED");
        h.grantTo(GRANDCHILD, _child(0, 1, 2));
    }

    function test_MaxDepthZeroIsALeaf() public {
        GrantStore.Grant memory leaf = _child(1 ether, 1, 0);
        vm.prank(registry);
        h.grantTo(CHILD, leaf);

        vm.prank(childRegistry);
        vm.expectRevert("DEPTH_EXCEEDED");
        h.grantTo(GRANDCHILD, _child(1 ether, 1, 0));
    }

    function test_DepthNarrowsEachHop() public {
        vm.prank(registry);
        h.grantTo(CHILD, _child(10 ether, 10, 2));

        vm.prank(childRegistry);
        h.grantTo(GRANDCHILD, _child(1 ether, 1, 1));

        assertEq(h.depthOf(ROOT), 0);
        assertEq(h.depthOf(CHILD), 1);
        assertEq(h.depthOf(GRANDCHILD), 2);
    }

    function test_OnlyAnAuthorizedRegistryMayGrant() public {
        vm.prank(address(0xDEAD));
        vm.expectRevert("NOT_REGISTRY");
        h.grantTo(CHILD, _child(1 ether, 1, 2));
    }

    function test_NothingMintsUnderAnUninitialisedParent() public {
        h.authorizeRegistry(address(0xFEED), 99);
        vm.prank(address(0xFEED));
        vm.expectRevert("PARENT_DEAD");
        h.grantTo(CHILD, _child(1 ether, 1, 2));
    }

    function test_RootRequiresTheDeviceSignature() public {
        Harness fresh = new Harness(device);
        GrantStore.RootMandate memory m = _mandate();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(uint256(0xBADBAD), fresh.hashMandate(m));

        vm.expectRevert("NOT_DEVICE");
        fresh.initRoot(m, abi.encodePacked(r, s, v));
    }

    function test_MandateCannotBeReplayed() public {
        GrantStore.RootMandate memory m = _mandate();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(deviceKey, h.hashMandate(m));

        vm.expectRevert("BAD_NONCE");
        h.initRoot(m, abi.encodePacked(r, s, v));
    }

    function test_NoOwnerPathToSeedTheRoot() public {
        Harness fresh = new Harness(device);
        assertEq(fresh.grantOf(ROOT).epoch, 0);
    }
}
