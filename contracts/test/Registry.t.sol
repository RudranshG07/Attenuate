// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {IEnhancedAccessControl} from "@ensv2/access-control/interfaces/IEnhancedAccessControl.sol";
import {LibLabel} from "@ensv2/utils/LibLabel.sol";
import {IRegistry} from "@ensv2/registry/interfaces/IRegistry.sol";
import {RegistryRolesLib} from "@ensv2/registry/libraries/RegistryRolesLib.sol";

import {AttenuatedSubregistry} from "../src/AttenuatedSubregistry.sol";
import {GrantStore} from "../src/GrantStore.sol";
import {SubregistryFactory} from "../src/SubregistryFactory.sol";
import {MockLabelStore} from "../src/mocks/MockLabelStore.sol";

contract RegistryTest is Test {
    GrantStore store;
    AttenuatedSubregistry reg;
    SubregistryFactory factory;
    MockLabelStore labels;

    uint256 constant ROOT = 1;

    uint256 constant REPAY = 0x04;
    uint256 constant DELEGATE = 0x80;

    uint256 deviceKey = 0xA11CE;
    address device;
    address agent = address(0xA6E7);
    address subAgent = address(0xB0B);
    address revoker = address(0xC0FFEE);

    function setUp() public {
        device = vm.addr(deviceKey);
        store = new GrantStore(device);
        labels = new MockLabelStore();
        factory = new SubregistryFactory(labels, store);

        uint256 roles = RegistryRolesLib.ROLE_REGISTRAR | RegistryRolesLib.ROLE_REGISTRAR_ADMIN
            | RegistryRolesLib.ROLE_SET_RESOLVER | RegistryRolesLib.ROLE_SET_SUBREGISTRY
            | RegistryRolesLib.ROLE_UNREGISTER_ADMIN;

        reg = new AttenuatedSubregistry(labels, address(this), roles, store, factory);

        // Deliberately not the account that holds ROLE_REGISTRAR.
        reg.grantRootRoles(RegistryRolesLib.ROLE_UNREGISTER, revoker);

        store.authorizeRegistry(address(reg), ROOT);

        GrantStore.RootMandate memory m = GrantStore.RootMandate({
            node: ROOT,
            capabilities: 0xFF,
            spendCap: 1000 ether,
            queryBudget: 1000,
            expiry: uint64(block.timestamp + 30 days),
            maxDepth: 3,
            nonce: 0
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(deviceKey, store.hashMandate(m));
        store.initRoot(m, abi.encodePacked(r, s, v));
    }

    function _grant(uint256 caps, uint256 cap, uint16 depth)
        internal
        view
        returns (GrantStore.Grant memory g)
    {
        g.capabilities = caps;
        g.spendCap = cap;
        g.queryBudget = 10;
        g.expiry = uint64(block.timestamp + 1 days);
        g.maxDepth = depth;
    }

    function _derived(string memory label) internal view returns (AttenuatedSubregistry) {
        return AttenuatedSubregistry(address(reg.getSubregistry(label)));
    }

    function test_StandardMintPathIsClosed() public {
        vm.expectRevert(AttenuatedSubregistry.UseRegisterWithGrant.selector);
        reg.register("exec", agent, IRegistry(address(0)), address(0), 0, uint64(block.timestamp + 1 days));
    }

    function test_AttenuatedGrantMints() public {
        uint256 id = reg.registerWithGrant("exec", agent, address(0), _grant(REPAY, 100 ether, 0));

        assertEq(reg.ownerOf(id), agent);
        assertTrue(store.isLive(id));
        assertEq(store.grantOf(id).spendRemaining, 100 ether);
        assertEq(store.grantOf(ROOT).spendRemaining, 900 ether);
    }

    function test_OverPrivilegedChildIsNeverCreated() public {
        vm.expectRevert("SCOPE_WIDENED");
        reg.registerWithGrant("evil", agent, address(0), _grant(0x1FF, 1 ether, 0));

        assertEq(store.grantOf(ROOT).spendRemaining, 1000 ether);
        assertEq(labels.getLabel(LibLabel.id("evil")), "");
    }

    function test_EscalationBecomesAnEventNotARevert() public {
        vm.recordLogs();

        (uint256 id, bool ok, string memory reason) =
            reg.registerOrLog("evil", agent, address(0), _grant(0x1FF, 1 ether, 0));

        assertEq(id, 0);
        assertFalse(ok);
        assertEq(reason, "SCOPE_WIDENED");

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == AttenuatedSubregistry.EscalationBlocked.selector) found = true;
        }
        assertTrue(found, "EscalationBlocked not emitted");
    }

    function test_LeafChildGetsNoRegistryAtAll() public {
        reg.registerWithGrant("exec", agent, address(0), _grant(REPAY, 1 ether, 0));

        assertEq(address(reg.getSubregistry("exec")), address(0));
    }

    function test_DelegatingChildGetsItsOwnRegistry() public {
        uint256 id = reg.registerWithGrant("risk", agent, address(0), _grant(REPAY | DELEGATE, 100 ether, 2));

        AttenuatedSubregistry child = _derived("risk");
        assertTrue(address(child) != address(0), "no registry derived");

        // The role that actually gates minting is ROOT_RESOURCE on the child's own registry.
        assertTrue(child.hasRootRoles(RegistryRolesLib.ROLE_REGISTRAR, agent));
        assertFalse(reg.hasRootRoles(RegistryRolesLib.ROLE_REGISTRAR, agent));

        assertTrue(store.isRegistry(address(child)));
        assertEq(store.nodeOf(address(child)), id);
    }

    function test_ChildCannotRepointItsOwnResolverOrSubregistry() public {
        uint256 id = reg.registerWithGrant("risk", agent, address(0), _grant(REPAY | DELEGATE, 1 ether, 1));

        assertFalse(reg.hasRoles(id, RegistryRolesLib.ROLE_SET_RESOLVER, agent));
        assertFalse(reg.hasRoles(id, RegistryRolesLib.ROLE_SET_SUBREGISTRY, agent));
    }

    function test_DelegatingChildCanActuallyDelegate() public {
        uint256 id = reg.registerWithGrant("risk", agent, address(0), _grant(REPAY | DELEGATE, 100 ether, 2));
        AttenuatedSubregistry child = _derived("risk");

        vm.prank(agent);
        uint256 grandId = child.registerWithGrant("probe", subAgent, address(0), _grant(REPAY, 40 ether, 0));

        assertEq(child.ownerOf(grandId), subAgent);
        assertTrue(store.isLive(grandId));
        assertEq(store.depthOf(grandId), 2);
        assertEq(store.grantOf(grandId).parent, id);
        assertEq(store.grantOf(id).spendRemaining, 60 ether);
    }

    function test_GrandchildCannotWidenBeyondItsParent() public {
        reg.registerWithGrant("risk", agent, address(0), _grant(REPAY | DELEGATE, 100 ether, 2));
        AttenuatedSubregistry child = _derived("risk");

        vm.prank(agent);
        vm.expectRevert("SCOPE_WIDENED");
        child.registerWithGrant("probe", subAgent, address(0), _grant(REPAY | 0x01, 1 ether, 0));

        vm.prank(agent);
        vm.expectRevert("CAP_EXCEEDS_UNALLOCATED");
        child.registerWithGrant("probe", subAgent, address(0), _grant(REPAY, 101 ether, 0));
    }

    function test_OnlyTheChildAgentMayMintInItsRegistry() public {
        reg.registerWithGrant("risk", agent, address(0), _grant(REPAY | DELEGATE, 100 ether, 2));
        AttenuatedSubregistry child = _derived("risk");

        // Built before the prank: an external call here would consume it.
        bytes memory err = abi.encodeWithSelector(
            IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
            child.ROOT_RESOURCE(),
            RegistryRolesLib.ROLE_REGISTRAR,
            address(0xBAD)
        );

        vm.prank(address(0xBAD));
        vm.expectRevert(err);
        child.registerWithGrant("probe", subAgent, address(0), _grant(REPAY, 1 ether, 0));
    }

    function test_ParentRegistryCanRevokeTheNameItGranted() public {
        uint256 id = reg.registerWithGrant("risk", agent, address(0), _grant(REPAY | DELEGATE, 100 ether, 2));
        AttenuatedSubregistry child = _derived("risk");

        vm.prank(agent);
        uint256 grandId = child.registerWithGrant("probe", subAgent, address(0), _grant(REPAY, 10 ether, 0));

        assertTrue(store.isLive(id));
        assertTrue(store.isLive(grandId));

        vm.prank(revoker);
        reg.revokeGrant(id);

        assertFalse(store.isLive(id));
        assertFalse(store.isLive(grandId), "descendant survived its parent");
    }

    function test_ARegistrarCannotRevoke() public {
        uint256 id = reg.registerWithGrant("exec", agent, address(0), _grant(REPAY, 1 ether, 0));

        bytes memory err = abi.encodeWithSelector(
            IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
            reg.ROOT_RESOURCE(),
            RegistryRolesLib.ROLE_UNREGISTER,
            address(this)
        );

        vm.expectRevert(err);
        reg.revokeGrant(id);
    }

    function test_ARevokerCannotGrant() public {
        bytes memory err = abi.encodeWithSelector(
            IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
            reg.ROOT_RESOURCE(),
            RegistryRolesLib.ROLE_REGISTRAR,
            revoker
        );

        vm.prank(revoker);
        vm.expectRevert(err);
        reg.registerWithGrant("exec", agent, address(0), _grant(REPAY, 1 ether, 0));
    }

    function test_ARegistryCannotRevokeANameItDidNotGrant() public {
        reg.registerWithGrant("risk", agent, address(0), _grant(REPAY | DELEGATE, 100 ether, 2));
        AttenuatedSubregistry child = _derived("risk");

        vm.prank(address(child));
        vm.expectRevert("NOT_REVOKER");
        store.revoke(ROOT);
    }

    function test_ADerivedRegistryIsUselessUntilTheStoreAuthorizesIt() public {
        // Anyone may deploy one, but it can mint nothing, because only the granting
        // registry can authorize a registry and only for the node it just granted.
        IRegistry rogue = factory.deployFor(address(0xBAD));

        assertFalse(store.isRegistry(address(rogue)));

        vm.prank(address(0xBAD));
        vm.expectRevert("NOT_REGISTRY");
        AttenuatedSubregistry(address(rogue)).registerWithGrant(
            "probe", address(0xBAD), address(0), _grant(0xFF, 1000 ether, 3)
        );
    }
}
