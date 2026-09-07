// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {ILabelStore} from "@ensv2/utils/interfaces/ILabelStore.sol";
import {LibLabel} from "@ensv2/utils/LibLabel.sol";
import {IRegistry} from "@ensv2/registry/interfaces/IRegistry.sol";
import {RegistryRolesLib} from "@ensv2/registry/libraries/RegistryRolesLib.sol";

import {AttenuatedSubregistry} from "../src/AttenuatedSubregistry.sol";
import {GrantStore} from "../src/GrantStore.sol";

contract MockLabelStore is ILabelStore {
    mapping(uint256 => string) internal _labels;

    function setLabel(string calldata label) external {
        _labels[LibLabel.withVersion(LibLabel.id(label), 0)] = label;
    }

    function getLabel(uint256 anyId) external view returns (string memory) {
        return _labels[LibLabel.withVersion(anyId, 0)];
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == type(ILabelStore).interfaceId;
    }
}

contract RegistryTest is Test {
    GrantStore store;
    AttenuatedSubregistry reg;
    MockLabelStore labels;

    uint256 constant ROOT = 1;

    uint256 deviceKey = 0xA11CE;
    address device;
    address agent = address(0xA6E7);

    function setUp() public {
        device = vm.addr(deviceKey);
        store = new GrantStore(device);
        labels = new MockLabelStore();

        uint256 roles = RegistryRolesLib.ROLE_REGISTRAR | RegistryRolesLib.ROLE_REGISTRAR_ADMIN
            | RegistryRolesLib.ROLE_SET_RESOLVER | RegistryRolesLib.ROLE_SET_SUBREGISTRY;

        reg = new AttenuatedSubregistry(labels, address(this), roles, store);

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

    function test_StandardMintPathIsClosed() public {
        vm.expectRevert(AttenuatedSubregistry.UseRegisterWithGrant.selector);
        reg.register("exec", agent, IRegistry(address(0)), address(0), 0, uint64(block.timestamp + 1 days));
    }

    function test_AttenuatedGrantMints() public {
        uint256 id = reg.registerWithGrant(
            "exec", agent, address(0), IRegistry(address(0)), _grant(0x04, 100 ether, 0)
        );

        assertEq(reg.ownerOf(id), agent);
        assertTrue(store.isLive(id));
        assertEq(store.grantOf(id).spendRemaining, 100 ether);
        assertEq(store.grantOf(ROOT).spendRemaining, 900 ether);
    }

    function test_OverPrivilegedChildIsNeverCreated() public {
        vm.expectRevert("SCOPE_WIDENED");
        reg.registerWithGrant(
            "evil", agent, address(0), IRegistry(address(0)), _grant(0x1FF, 1 ether, 0)
        );

        assertEq(store.grantOf(ROOT).spendRemaining, 1000 ether);
        assertEq(labels.getLabel(LibLabel.id("evil")), "");
    }

    function test_EscalationBecomesAnEventNotARevert() public {
        vm.recordLogs();

        (uint256 id, bool ok, string memory reason) = reg.registerOrLog(
            "evil", agent, address(0), IRegistry(address(0)), _grant(0x1FF, 1 ether, 0)
        );

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

    function test_NonDelegatingChildGetsNoRegistrarRole() public {
        uint256 id = reg.registerWithGrant(
            "exec", agent, address(0), IRegistry(address(0)), _grant(0x04, 1 ether, 0)
        );
        assertFalse(reg.hasRoles(id, RegistryRolesLib.ROLE_REGISTRAR, agent));
    }

    function test_DelegatingChildGetsRegistrarRole() public {
        uint256 id = reg.registerWithGrant(
            "risk", agent, address(0), IRegistry(address(0)), _grant(0x84, 1 ether, 1)
        );
        assertTrue(reg.hasRoles(id, RegistryRolesLib.ROLE_REGISTRAR, agent));
    }
}
