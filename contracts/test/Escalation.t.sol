// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IEnhancedAccessControl} from "@ensv2/access-control/interfaces/IEnhancedAccessControl.sol";
import {RegistryRolesLib} from "@ensv2/registry/libraries/RegistryRolesLib.sol";

import {AttenuatedSubregistry} from "../src/AttenuatedSubregistry.sol";
import {CapabilityRegistry} from "../src/CapabilityRegistry.sol";
import {Executor} from "../src/Executor.sol";
import {GrantStore} from "../src/GrantStore.sol";
import {SubregistryFactory} from "../src/SubregistryFactory.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockLabelStore} from "../src/mocks/MockLabelStore.sol";
import {MockPool} from "../src/mocks/MockPool.sol";

// Calls back into the executor while the executor is still inside its own call.
contract Reenterer {
    Executor public ex;
    uint256 public node;

    function arm(Executor e, uint256 n) external {
        ex = e;
        node = n;
    }

    function kick(uint8 capBit) external {
        ex.execute(node, capBit, address(this), 0, _payload());
    }

    function repay(address, uint256, uint256, address) external returns (uint256) {
        ex.execute(node, 2, address(this), 0, _payload());
        return 0;
    }

    function _payload() internal pure returns (bytes memory) {
        return abi.encodeWithSelector(this.repay.selector, address(0), uint256(1), uint256(0), address(0));
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }
}

// One named scenario per refusal, each asserting the reason the contracts actually emit.
// Where the emitted reason differs from the one you would expect, the difference is noted
// rather than papered over.
contract EscalationTest is Test {
    GrantStore store;
    SubregistryFactory factory;
    AttenuatedSubregistry root;
    CapabilityRegistry caps;
    Executor ex;
    MockERC20 usdc;
    MockPool pool;
    MockLabelStore labels;

    uint256 constant ROOT = 1;

    uint8 constant SWAP = 0;
    uint8 constant REPAY = 2;
    uint8 constant APPROVE = 4;
    uint8 constant READ = 6;

    uint256 constant C_SWAP = 1 << 0;
    uint256 constant C_REPAY = 1 << 2;
    uint256 constant C_APPROVE = 1 << 4;
    uint256 constant C_READ = 1 << 6;
    uint256 constant C_DELEGATE = 1 << 7;

    uint256 constant LEAF_CAPS = C_REPAY | C_APPROVE | C_READ;

    uint256 deviceKey = 0xA11CE;
    address device;
    address revoker = address(0xC0FFEE);
    address agent = address(0xA6E7);
    address subAgent = address(0xB0B);
    address stranger = address(0xBAD);

    uint64 rootExpiry;
    uint256 execNode;
    uint256 rootResource;

    function setUp() public {
        device = vm.addr(deviceKey);
        store = new GrantStore(device);
        labels = new MockLabelStore();
        factory = new SubregistryFactory(labels, store);

        uint256 roles = RegistryRolesLib.ROLE_REGISTRAR | RegistryRolesLib.ROLE_REGISTRAR_ADMIN
            | RegistryRolesLib.ROLE_UNREGISTER_ADMIN;
        root = new AttenuatedSubregistry(labels, address(this), roles, store, factory);
        root.grantRootRoles(RegistryRolesLib.ROLE_UNREGISTER, revoker);
        rootResource = root.ROOT_RESOURCE();

        store.authorizeRegistry(address(root), ROOT);

        rootExpiry = uint64(block.timestamp + 30 days);
        GrantStore.RootMandate memory m = GrantStore.RootMandate({
            node: ROOT,
            capabilities: 0xFF,
            spendCap: 1000 ether,
            queryBudget: 1000,
            expiry: rootExpiry,
            maxDepth: 3,
            nonce: 0
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(deviceKey, store.hashMandate(m));
        store.initRoot(m, abi.encodePacked(r, s, v));

        usdc = new MockERC20("Mock USDC", "USDC", 18);
        pool = new MockPool(usdc);
        caps = new CapabilityRegistry(address(usdc));
        ex = new Executor(store, caps);

        store.setExecutor(address(ex));
        usdc.mint(address(ex), 1000 ether);
        ex.setAllowance(address(usdc), address(pool), type(uint256).max);
        pool.setDebt(address(ex), 500 ether);

        caps.setCap(REPAY, _spec(address(pool), MockPool.repay.selector, 1, 0, false));
        caps.setCap(SWAP, _spec(address(pool), MockPool.repay.selector, 1, 0, false));
        caps.setCap(READ, _spec(address(pool), MockPool.healthFactor.selector, caps.NO_AMOUNT(), 1, true));

        CapabilityRegistry.CapSpec memory approve = _spec(address(usdc), MockERC20.approve.selector, 1, 0, false);
        approve.pinnedArg = address(pool);
        approve.pinnedArgIndex = 0;
        caps.setCap(APPROVE, approve);

        execNode = root.registerWithGrant("exec", agent, address(0), _grant(LEAF_CAPS, 50 ether, 0));
    }

    ////////////////////////////////////////////////////////////////////////
    // Helpers
    ////////////////////////////////////////////////////////////////////////

    function _spec(address target, bytes4 selector, uint8 amountIdx, uint32 queryCost, bool readSafe)
        internal
        view
        returns (CapabilityRegistry.CapSpec memory s)
    {
        s.target = target;
        s.selector = selector;
        s.amountArgIndex = amountIdx;
        s.queryCost = queryCost;
        s.readSafe = readSafe;
        s.pinnedArgIndex = caps.NO_ARG();
    }

    function _grant(uint256 capabilities, uint256 spendCap, uint16 maxDepth)
        internal
        view
        returns (GrantStore.Grant memory g)
    {
        g.capabilities = capabilities;
        g.spendCap = spendCap;
        g.queryBudget = 10;
        g.expiry = uint64(block.timestamp + 1 days);
        g.maxDepth = maxDepth;
    }

    function _delegatingChild(uint256 capabilities, uint256 spendCap, uint16 maxDepth)
        internal
        returns (AttenuatedSubregistry child, uint256 id)
    {
        id = root.registerWithGrant("risk", agent, address(0), _grant(capabilities | C_DELEGATE, spendCap, maxDepth));
        child = AttenuatedSubregistry(address(root.getSubregistry("risk")));
    }

    function _repay(uint256 amount) internal view returns (bytes memory) {
        return abi.encodeWithSelector(MockPool.repay.selector, address(usdc), amount, uint256(0), address(ex));
    }

    function _read() internal view returns (bytes memory) {
        return abi.encodeWithSelector(MockPool.healthFactor.selector, address(ex));
    }

    // Reads the cached resource rather than calling the registry: an external call here
    // would be made under any active prank and consume it before the call under test.
    function _unauthorized(uint256 role, address account) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector, rootResource, role, account
        );
    }

    ////////////////////////////////////////////////////////////////////////
    // Refused at mint time: the name never exists
    ////////////////////////////////////////////////////////////////////////

    function test_01_ChildSetsBitParentLacks() public {
        // Root holds 0xFF, so nothing in one byte can widen it. Bit 8 can.
        vm.expectRevert("SCOPE_WIDENED");
        root.registerWithGrant("evil", agent, address(0), _grant(1 << 8, 1 ether, 0));
    }

    function test_02_ChildSpendCapExceedsUnallocated() public {
        vm.expectRevert("CAP_EXCEEDS_UNALLOCATED");
        root.registerWithGrant("greedy", agent, address(0), _grant(C_REPAY, 1001 ether, 0));
    }

    function test_03_ChildExpiryBeyondParent() public {
        GrantStore.Grant memory g = _grant(C_REPAY, 1 ether, 0);
        g.expiry = rootExpiry + 1;

        vm.expectRevert("EXPIRY_EXTENDED");
        root.registerWithGrant("outlives", agent, address(0), g);
    }

    function test_04_GrandchildReAddsDroppedBit() public {
        // The child drops swap. Two hops down it cannot come back.
        (AttenuatedSubregistry child,) = _delegatingChild(C_REPAY, 100 ether, 2);

        vm.prank(agent);
        vm.expectRevert("SCOPE_WIDENED");
        child.registerWithGrant("probe", subAgent, address(0), _grant(C_REPAY | C_SWAP, 1 ether, 0));
    }

    function test_05_ReadOnlyParentCannotGrantWritableChild() public {
        GrantStore.Grant memory g = _grant(C_REPAY | C_DELEGATE, 100 ether, 2);
        g.readOnly = true;
        root.registerWithGrant("risk", agent, address(0), g);
        AttenuatedSubregistry child = AttenuatedSubregistry(address(root.getSubregistry("risk")));

        vm.prank(agent);
        vm.expectRevert("READONLY_ESCALATION");
        child.registerWithGrant("probe", subAgent, address(0), _grant(C_REPAY, 1 ether, 0));
    }

    function test_06_DelegatePastMaxDepth() public {
        // maxDepth 0 is the leaf condition: strict less-than leaves nothing to grant.
        (AttenuatedSubregistry child,) = _delegatingChild(C_REPAY, 100 ether, 0);

        vm.prank(agent);
        vm.expectRevert("DEPTH_EXCEEDED");
        child.registerWithGrant("probe", subAgent, address(0), _grant(C_REPAY, 1 ether, 0));
    }

    function test_08_DoubleAllocationOfSpendBudget() public {
        root.registerWithGrant("first", agent, address(0), _grant(C_REPAY, 950 ether, 0));

        // 1000 was the mandate, 50 went to exec and 950 to first. Nothing is unallocated.
        vm.expectRevert("CAP_EXCEEDS_UNALLOCATED");
        root.registerWithGrant("second", subAgent, address(0), _grant(C_REPAY, 1 ether, 0));
    }

    function test_11_RevokerCannotGrant() public {
        vm.prank(revoker);
        vm.expectRevert(_unauthorized(RegistryRolesLib.ROLE_REGISTRAR, revoker));
        root.registerWithGrant("exec2", agent, address(0), _grant(C_REPAY, 1 ether, 0));
    }

    function test_12_GrantUnderRevokedParent() public {
        (AttenuatedSubregistry child, uint256 id) = _delegatingChild(C_REPAY, 100 ether, 2);

        vm.prank(revoker);
        root.revokeGrant(id);

        vm.prank(agent);
        vm.expectRevert("PARENT_DEAD");
        child.registerWithGrant("probe", subAgent, address(0), _grant(C_REPAY, 1 ether, 0));
    }

    function test_15_DoubleAllocationOfQueryBudget() public {
        GrantStore.Grant memory first = _grant(C_READ, 1 ether, 0);
        first.queryBudget = 990;
        root.registerWithGrant("first", agent, address(0), first);

        GrantStore.Grant memory second = _grant(C_READ, 1 ether, 0);
        second.queryBudget = 1;

        vm.expectRevert("BUDGET_EXCEEDS_UNALLOCATED");
        root.registerWithGrant("second", subAgent, address(0), second);
    }

    ////////////////////////////////////////////////////////////////////////
    // Refused at use time: the action is outside the resolved grant
    ////////////////////////////////////////////////////////////////////////

    function test_07_ExecuteAfterRootRevoked() public {
        store.revoke(ROOT);

        vm.prank(agent);
        vm.expectRevert("REVOKED_OR_EXPIRED");
        ex.execute(execNode, REPAY, address(pool), 0, _repay(1 ether));
    }

    function test_09_NonAgentCallsExecute() public {
        vm.prank(stranger);
        vm.expectRevert("NOT_AGENT");
        ex.execute(execNode, REPAY, address(pool), 0, _repay(1 ether));
    }

    function test_10_ValidCapWrongTarget() public {
        vm.prank(agent);
        vm.expectRevert("TARGET_MISMATCH");
        ex.execute(execNode, REPAY, address(0xDEAD), 0, _repay(1 ether));
    }

    function test_13_ERC20AmountExceedsBudget() public {
        vm.prank(agent);
        vm.expectRevert("OVER_BUDGET");
        ex.execute(execNode, REPAY, address(pool), 0, _repay(51 ether));

        assertEq(usdc.balanceOf(address(ex)), 1000 ether, "asset moved on a refused call");
    }

    function test_14_ReadOnlyInvokesStateChangingCap() public {
        GrantStore.Grant memory g = _grant(LEAF_CAPS, 10 ether, 0);
        g.readOnly = true;
        uint256 id = root.registerWithGrant("watch", subAgent, address(0), g);

        vm.prank(subAgent);
        vm.expectRevert("READONLY");
        ex.execute(id, REPAY, address(pool), 0, _repay(1 ether));

        // Checking value == 0 would not have caught this: repay moves tokens, not ether.
        vm.prank(subAgent);
        ex.execute(id, READ, address(pool), 0, _read());
    }

    function test_19_ReentrantExecuteDuringExecute() public {
        Reenterer r = new Reenterer();
        uint256 id = root.registerWithGrant("loop", address(r), address(0), _grant(LEAF_CAPS, 50 ether, 0));
        r.arm(ex, id);
        caps.setCap(REPAY, _spec(address(r), Reenterer.repay.selector, 1, 0, false));

        // The guard reverts REENTRANT, but it does so underneath target.call, so what
        // surfaces to the caller is the failed outer call. The table says CALL_FAILED
        // because that is what the contract emits.
        vm.expectRevert("CALL_FAILED");
        r.kick(REPAY);
    }

    function test_20_ShortCalldata() public {
        vm.prank(agent);
        vm.expectRevert("CALLDATA_SHORT");
        ex.execute(execNode, REPAY, address(pool), 0, hex"aabb");
    }

    function test_21_ApproveAimedAtAnUnpinnedSpender() public {
        // Target and selector are both legitimate; only the counterparty is wrong.
        vm.prank(agent);
        vm.expectRevert("ARG_MISMATCH");
        ex.execute(
            execNode, APPROVE, address(usdc), 0, abi.encodeWithSelector(MockERC20.approve.selector, agent, 50 ether)
        );

        assertEq(usdc.allowance(address(ex), agent), 0);
    }

    ////////////////////////////////////////////////////////////////////////
    // Refused bookkeeping: terminal states stay terminal
    ////////////////////////////////////////////////////////////////////////

    function test_16_DoubleRevoke() public {
        vm.prank(revoker);
        root.revokeGrant(execNode);

        vm.prank(revoker);
        vm.expectRevert("ALREADY_REVOKED");
        root.revokeGrant(execNode);
    }

    function test_17_ReclaimLiveNode() public {
        vm.expectRevert("STILL_LIVE");
        store.reclaim(execNode);
    }

    function test_18_DoubleReclaim() public {
        vm.prank(revoker);
        root.revokeGrant(execNode);

        store.reclaim(execNode);

        vm.expectRevert("ALREADY_RECLAIMED");
        store.reclaim(execNode);
    }
}
