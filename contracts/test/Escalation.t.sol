// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

contract EscalationTest is Test {
    function setUp() public {}

    function test_01_ChildSetsBitParentLacks() public {}

    function test_02_ChildSpendCapExceedsUnallocated() public {}

    function test_03_ChildExpiryBeyondParent() public {}

    function test_04_GrandchildReAddsDroppedBit() public {}

    function test_05_ChildDeEscalatesReadOnly() public {}

    function test_06_DelegatePastMaxDepth() public {}

    function test_07_ExecuteAfterRootRevoked() public {}

    function test_08_DoubleAllocationOfSpendBudget() public {}

    function test_09_NonAgentCallsExecute() public {}

    function test_10_ValidCapWrongTarget() public {}

    function test_11_RevokerCannotGrant() public {}

    function test_12_GrantUnderRevokedParent() public {}

    function test_13_ERC20AmountExceedsBudget() public {}

    function test_14_ReadOnlyInvokesStateChangingCap() public {}

    function test_15_DoubleAllocationOfQueryBudget() public {}

    function test_16_DoubleRevoke() public {}

    function test_17_ReclaimLiveNode() public {}

    function test_18_DoubleReclaim() public {}

    function test_19_ReentrantRegisterDuringExecute() public {}

    function test_20_ShortCalldata() public {}
}
