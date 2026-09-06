// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

contract RevocationTest is Test {
    function setUp() public {}

    function test_RootRevocationKillsWholeSubtreeSameBlock() public {}

    function test_RevokeGasIsConstantRegardlessOfSubtreeSize() public {}

    function test_ReclaimSweepsDeadSubtreeToNearestLiveAncestor() public {}

    function test_IsLiveFailsClosedOnDepthOverflow() public {}

    function test_ExpiredNodeIsNotLive() public {}
}
