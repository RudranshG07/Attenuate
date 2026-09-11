// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IRegistry} from "@ensv2/registry/interfaces/IRegistry.sol";

interface ISubregistryFactory {
    function deployFor(address agent) external returns (IRegistry);
}
