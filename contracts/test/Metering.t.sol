// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CapabilityRegistry} from "../src/CapabilityRegistry.sol";
import {Executor} from "../src/Executor.sol";
import {GrantStore} from "../src/GrantStore.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockPool} from "../src/mocks/MockPool.sol";

contract Reenterer {
    Executor public ex;

    function repay(address, uint256, uint256, address) external returns (uint256) {
        ex.execute(
            1,
            2,
            address(this),
            0,
            abi.encodeWithSelector(this.repay.selector, address(0), uint256(1), uint256(0), address(0))
        );
        return 0;
    }

    function set(Executor e) external {
        ex = e;
    }
}

contract StoreHarness is GrantStore {
    constructor(address d) GrantStore(d) {}

    function seed(uint256 node, address agent, Grant calldata g) external {
        Grant storage x = grants[node];
        x.capabilities = g.capabilities;
        x.spendCap = g.spendCap;
        x.spendRemaining = g.spendCap;
        x.queryBudget = g.queryBudget;
        x.queryRemaining = g.queryBudget;
        x.expiry = g.expiry;
        x.maxDepth = g.maxDepth;
        x.readOnly = g.readOnly;
        x.epoch = 1;
        agentOf[node] = agent;
    }
}

contract MeteringTest is Test {
    StoreHarness store;
    CapabilityRegistry caps;
    Executor ex;
    MockERC20 usdc;
    MockPool pool;

    uint256 constant NODE = 1;

    uint8 constant SWAP = 0;
    uint8 constant SUPPLY = 1;
    uint8 constant REPAY = 2;
    uint8 constant APPROVE = 4;
    uint8 constant READ = 6;

    // swap is deliberately absent, so there is a bit to be missing.
    uint256 constant GRANTED = 0x56;

    address agent = address(0xA6E7);

    function setUp() public {
        store = new StoreHarness(address(0xA11CE));
        usdc = new MockERC20("Mock USDC", "USDC", 18);
        pool = new MockPool(usdc);
        caps = new CapabilityRegistry(address(usdc));
        ex = new Executor(store, caps);

        store.setExecutor(address(ex));

        usdc.mint(address(ex), 1000 ether);
        ex.setAllowance(address(usdc), address(pool), type(uint256).max);
        pool.setDebt(address(ex), 500 ether);

        caps.setCap(REPAY, _spec(address(pool), MockPool.repay.selector, 1, 0, false));
        caps.setCap(SUPPLY, _spec(address(pool), MockPool.supply.selector, 1, 0, false));
        caps.setCap(SWAP, _spec(address(pool), MockPool.repay.selector, 1, 0, false));
        caps.setCap(READ, _spec(address(pool), MockPool.healthFactor.selector, caps.NO_AMOUNT(), 1, true));

        // The spender is pinned, so holding this bit is permission to approve the pool and
        // nothing else.
        CapabilityRegistry.CapSpec memory approve =
            _spec(address(usdc), MockERC20.approve.selector, 1, 0, false);
        approve.pinnedArg = address(pool);
        approve.pinnedArgIndex = 0;
        caps.setCap(APPROVE, approve);

        _seed(GRANTED, 100 ether, false);
    }

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

    function _seed(uint256 capabilities, uint256 cap, bool readOnly) internal {
        GrantStore.Grant memory g;
        g.capabilities = capabilities;
        g.spendCap = cap;
        g.queryBudget = 10;
        g.expiry = uint64(block.timestamp + 1 days);
        g.maxDepth = 1;
        g.readOnly = readOnly;
        store.seed(NODE, agent, g);
    }

    function _repay(uint256 amount) internal view returns (bytes memory) {
        return abi.encodeWithSelector(MockPool.repay.selector, address(usdc), amount, uint256(0), address(ex));
    }

    function _read() internal view returns (bytes memory) {
        return abi.encodeWithSelector(MockPool.healthFactor.selector, address(ex));
    }

    function test_ERC20AmountIsMeteredFromCalldata() public {
        vm.prank(agent);
        ex.execute(NODE, REPAY, address(pool), 0, _repay(40 ether));

        assertEq(store.grantOf(NODE).spendRemaining, 60 ether);
        assertEq(usdc.balanceOf(address(ex)), 960 ether, "asset did not actually move");
        assertEq(usdc.balanceOf(address(pool)), 40 ether);
        assertEq(pool.debtOf(address(ex)), 460 ether);
    }

    function test_ERC20AmountExceedingBudgetReverts() public {
        vm.prank(agent);
        vm.expectRevert("OVER_BUDGET");
        ex.execute(NODE, REPAY, address(pool), 0, _repay(101 ether));

        assertEq(usdc.balanceOf(address(ex)), 1000 ether);
    }

    function test_RepeatedSpendsDrawDownMonotonically() public {
        vm.startPrank(agent);
        ex.execute(NODE, REPAY, address(pool), 0, _repay(30 ether));
        ex.execute(NODE, REPAY, address(pool), 0, _repay(30 ether));
        assertEq(store.grantOf(NODE).spendRemaining, 40 ether);
        vm.expectRevert("OVER_BUDGET");
        ex.execute(NODE, REPAY, address(pool), 0, _repay(41 ether));
        vm.stopPrank();
    }

    function test_ReadOnlyCannotInvokeStateChangingCap() public {
        _seed(GRANTED, 100 ether, true);
        vm.prank(agent);
        vm.expectRevert("READONLY");
        ex.execute(NODE, REPAY, address(pool), 0, _repay(1 ether));
    }

    function test_ReadOnlyMayInvokeReadSafeCap() public {
        _seed(GRANTED, 100 ether, true);
        vm.prank(agent);
        ex.execute(NODE, READ, address(pool), 0, _read());
        assertEq(store.grantOf(NODE).spendRemaining, 100 ether);
    }

    function test_PaidReadDrawsDownTheQueryBudget() public {
        assertEq(store.grantOf(NODE).queryRemaining, 10);

        vm.startPrank(agent);
        ex.execute(NODE, READ, address(pool), 0, _read());
        ex.execute(NODE, READ, address(pool), 0, _read());
        vm.stopPrank();

        assertEq(store.grantOf(NODE).queryRemaining, 8);
        assertEq(store.grantOf(NODE).spendRemaining, 100 ether);
    }

    function test_ExhaustedQueryBudgetReverts() public {
        vm.startPrank(agent);
        for (uint256 i = 0; i < 10; i++) {
            ex.execute(NODE, READ, address(pool), 0, _read());
        }
        assertEq(store.grantOf(NODE).queryRemaining, 0);

        vm.expectRevert("OVER_QUERY_BUDGET");
        ex.execute(NODE, READ, address(pool), 0, _read());
        vm.stopPrank();
    }

    function test_SpendingCapabilitiesDoNotTouchTheQueryBudget() public {
        vm.prank(agent);
        ex.execute(NODE, REPAY, address(pool), 0, _repay(40 ether));

        assertEq(store.grantOf(NODE).queryRemaining, 10);
        assertEq(store.grantOf(NODE).spendRemaining, 60 ether);
    }

    function test_ApproveIsAllowedWhenAimedAtThePinnedSpender() public {
        vm.prank(agent);
        ex.execute(
            NODE, APPROVE, address(usdc), 0, abi.encodeWithSelector(MockERC20.approve.selector, address(pool), 25 ether)
        );

        assertEq(usdc.allowance(address(ex), address(pool)), 25 ether);
        assertEq(store.grantOf(NODE).spendRemaining, 75 ether);
    }

    function test_AgentCannotApproveItselfAndDrainTheExecutor() public {
        vm.prank(agent);
        vm.expectRevert("ARG_MISMATCH");
        ex.execute(
            NODE, APPROVE, address(usdc), 0, abi.encodeWithSelector(MockERC20.approve.selector, agent, 100 ether)
        );

        assertEq(usdc.allowance(address(ex), agent), 0);
        assertEq(usdc.balanceOf(address(ex)), 1000 ether);
    }

    function test_MissingCapabilityBitReverts() public {
        vm.prank(agent);
        vm.expectRevert("CAP_MISSING");
        ex.execute(NODE, SWAP, address(pool), 0, _repay(1 ether));
    }

    function test_WrongTargetReverts() public {
        vm.prank(agent);
        vm.expectRevert("TARGET_MISMATCH");
        ex.execute(NODE, REPAY, address(0xDEAD), 0, _repay(1 ether));
    }

    function test_WrongSelectorReverts() public {
        vm.prank(agent);
        vm.expectRevert("SELECTOR_MISMATCH");
        ex.execute(NODE, REPAY, address(pool), 0, abi.encodeWithSelector(MockPool.supply.selector, address(usdc), uint256(1), uint16(0), address(ex)));
    }

    function test_NonAgentReverts() public {
        vm.prank(address(0xBAD));
        vm.expectRevert("NOT_AGENT");
        ex.execute(NODE, REPAY, address(pool), 0, _repay(1 ether));
    }

    function test_ShortCalldataReverts() public {
        vm.prank(agent);
        vm.expectRevert("CALLDATA_SHORT");
        ex.execute(NODE, REPAY, address(pool), 0, hex"aabb");
    }

    function test_DisabledCapReverts() public {
        caps.disableCap(REPAY);
        vm.prank(agent);
        vm.expectRevert("CAP_DISABLED");
        ex.execute(NODE, REPAY, address(pool), 0, _repay(1 ether));
    }

    function test_ExecuteAfterRevokeReverts() public {
        store.revoke(NODE);
        vm.prank(agent);
        vm.expectRevert("REVOKED_OR_EXPIRED");
        ex.execute(NODE, REPAY, address(pool), 0, _repay(1 ether));
    }

    function test_ReentrantExecuteReverts() public {
        Reenterer r = new Reenterer();
        r.set(ex);
        caps.setCap(REPAY, _spec(address(r), Reenterer.repay.selector, 1, 0, false));
        store.seed(NODE, address(r), _grantFor());

        vm.prank(address(r));
        vm.expectRevert("CALL_FAILED");
        ex.execute(
            NODE,
            REPAY,
            address(r),
            0,
            abi.encodeWithSelector(Reenterer.repay.selector, address(0), uint256(1), uint256(0), address(0))
        );
    }

    function _grantFor() internal view returns (GrantStore.Grant memory g) {
        g.capabilities = GRANTED;
        g.spendCap = 100 ether;
        g.queryBudget = 10;
        g.expiry = uint64(block.timestamp + 1 days);
        g.maxDepth = 1;
    }
}
