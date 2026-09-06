// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {AttenuatedSubregistry} from "../src/AttenuatedSubregistry.sol";

contract AttenuationTest is Test {
    function setUp() public {}

    function testFuzz_ChildNeverExceedsParent(
        AttenuatedSubregistry.Grant memory p,
        AttenuatedSubregistry.Grant memory c
    ) public {}

    function invariant_TreeNeverExceedsRootMandate() public {}

    function test_MaxDepthZeroIsALeaf() public {}

    function test_NothingMeaningfulMintsUnderRoot() public {}
}
