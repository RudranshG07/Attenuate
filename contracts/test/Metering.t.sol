// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

contract MeteringTest is Test {
    function setUp() public {}

    function test_ExtractsAaveRepayAmount() public {}

    function test_ExtractsAaveSupplyAmount() public {}

    function test_ExtractsApproveAmount() public {}

    function test_NativeTransferMeteredByValue() public {}

    function test_ValuePlusCalldataAmountSummed() public {}

    function test_ShortCalldataRevertsNotUnderflows() public {}

    function test_SpendRemainingMonotonicallyDecreases() public {}
}
