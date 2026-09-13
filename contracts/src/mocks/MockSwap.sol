// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MockERC20} from "./MockERC20.sol";

// Distinct from repay. Pulls tokenIn and pays tokenOut 1:1 so the swap bit
// authorises a different (target, selector) than lending.
contract MockSwap {
    MockERC20 public immutable TOKEN_IN;
    MockERC20 public immutable TOKEN_OUT;

    constructor(MockERC20 tokenIn, MockERC20 tokenOut) {
        TOKEN_IN = tokenIn;
        TOKEN_OUT = tokenOut;
    }

    function swap(address tokenIn, uint256 amountIn, uint256 minOut) external returns (uint256 amountOut) {
        require(tokenIn == address(TOKEN_IN), "BAD_TOKEN");
        amountOut = amountIn;
        require(amountOut >= minOut, "SLIPPAGE");
        TOKEN_IN.transferFrom(msg.sender, address(this), amountIn);
        TOKEN_OUT.transfer(msg.sender, amountOut);
    }
}
