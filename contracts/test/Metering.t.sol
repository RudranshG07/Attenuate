// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CapabilityRegistry} from "../src/CapabilityRegistry.sol";
import {Executor} from "../src/Executor.sol";
import {GrantStore} from "../src/GrantStore.sol";

contract MockPool {
    uint256 public lastAmount;

    function repay(address, uint256 amount, uint256, address) external returns (uint256) {
        lastAmount = amount;
        return amount;
    }
}

contract Reenterer {
    Executor public ex;

    function repay(address, uint256, uint256, address) external returns (uint256) {
        ex.execute(1, 2, address(this), 0, abi.encodeWithSelector(this.repay.selector, address(0), uint256(1), uint256(0), address(0)));
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
    MockPool pool;

    uint256 constant NODE = 1;
    uint8 constant REPAY = 2;
    uint8 constant READ = 6;
    uint8 constant SWAP = 0;
    address agent = address(0xA6E7);

    function setUp() public {
        store = new StoreHarness(address(0xA11CE));
        caps = new CapabilityRegistry(address(0));
        ex = new Executor(store, caps);
        pool = new MockPool();

        store.setExecutor(address(ex));
        caps.setCap(REPAY, address(pool), MockPool.repay.selector, 1, false);
        caps.setCap(READ, address(pool), MockPool.repay.selector, caps.NO_AMOUNT(), true);
        caps.setCap(SWAP, address(pool), MockPool.repay.selector, 1, false);

        _seed(0x44, 100 ether, false);
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

    function _repay(uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(MockPool.repay.selector, address(0), amount, uint256(0), address(0));
    }

    function test_ERC20AmountIsMeteredFromCalldata() public {
        vm.prank(agent);
        ex.execute(NODE, REPAY, address(pool), 0, _repay(40 ether));

        assertEq(pool.lastAmount(), 40 ether);
        assertEq(store.grantOf(NODE).spendRemaining, 60 ether);
    }

    function test_ERC20AmountExceedingBudgetReverts() public {
        vm.prank(agent);
        vm.expectRevert("OVER_BUDGET");
        ex.execute(NODE, REPAY, address(pool), 0, _repay(101 ether));
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
        _seed(0x44, 100 ether, true);
        vm.prank(agent);
        vm.expectRevert("READONLY");
        ex.execute(NODE, REPAY, address(pool), 0, _repay(1 ether));
    }

    function test_ReadOnlyMayInvokeReadSafeCap() public {
        _seed(0x44, 100 ether, true);
        vm.prank(agent);
        ex.execute(NODE, READ, address(pool), 0, _repay(1 ether));
        assertEq(store.grantOf(NODE).spendRemaining, 100 ether);
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

    function test_ExecuteAfterRevokeReverts() public {
        store.revoke(NODE);
        vm.prank(agent);
        vm.expectRevert("REVOKED_OR_EXPIRED");
        ex.execute(NODE, REPAY, address(pool), 0, _repay(1 ether));
    }

    function test_ReentrantExecuteReverts() public {
        Reenterer r = new Reenterer();
        r.set(ex);
        caps.setCap(REPAY, address(r), Reenterer.repay.selector, 1, false);
        store.seed(NODE, address(r), _grantFor());

        vm.prank(address(r));
        vm.expectRevert("CALL_FAILED");
        ex.execute(NODE, REPAY, address(r), 0, abi.encodeWithSelector(Reenterer.repay.selector, address(0), uint256(1), uint256(0), address(0)));
    }

    function _grantFor() internal view returns (GrantStore.Grant memory g) {
        g.capabilities = 0x44;
        g.spendCap = 100 ether;
        g.queryBudget = 10;
        g.expiry = uint64(block.timestamp + 1 days);
        g.maxDepth = 1;
    }
}
