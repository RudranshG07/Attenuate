// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MockERC20} from "./MockERC20.sol";

// Aave-shaped repay/supply. Pulls the asset, so the executor genuinely needs an allowance.
contract MockPool {
    MockERC20 public immutable ASSET;

    mapping(address => uint256) public debtOf;
    mapping(address => uint256) public suppliedOf;

    constructor(MockERC20 asset) {
        ASSET = asset;
    }

    function setDebt(address who, uint256 amount) external {
        debtOf[who] = amount;
    }

    function repay(address, uint256 amount, uint256, address onBehalfOf) external returns (uint256) {
        ASSET.transferFrom(msg.sender, address(this), amount);
        uint256 debt = debtOf[onBehalfOf];
        debtOf[onBehalfOf] = amount >= debt ? 0 : debt - amount;
        return amount;
    }

    function supply(address, uint256 amount, uint16, address onBehalfOf) external {
        ASSET.transferFrom(msg.sender, address(this), amount);
        suppliedOf[onBehalfOf] += amount;
    }

    function withdraw(address, uint256 amount, address to) external returns (uint256) {
        uint256 have = suppliedOf[msg.sender];
        require(have >= amount, "INSUFFICIENT_SUPPLY");
        suppliedOf[msg.sender] = have - amount;
        ASSET.transfer(to, amount);
        return amount;
    }

    function healthFactor(address who) external view returns (uint256) {
        uint256 debt = debtOf[who];
        return debt == 0 ? type(uint256).max : (suppliedOf[who] * 1e18) / debt;
    }
}
