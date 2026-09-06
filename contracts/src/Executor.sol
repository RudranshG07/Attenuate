// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AttenuatedSubregistry} from "./AttenuatedSubregistry.sol";
import {CapabilityRegistry} from "./CapabilityRegistry.sol";

contract Executor {
    AttenuatedSubregistry public immutable registry;
    CapabilityRegistry public immutable capReg;

    uint8 internal constant NO_AMOUNT = 0xFF;

    uint256 private _lock = 1;

    event Executed(bytes32 indexed node, uint8 indexed capBit, address target, uint256 spend);

    modifier nonReentrant() {
        require(_lock == 1, "REENTRANT");
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(AttenuatedSubregistry _registry, CapabilityRegistry _capReg) {
        registry = _registry;
        capReg = _capReg;
    }

    function execute(bytes32 node, uint8 capBit, address target, uint256 value, bytes calldata data)
        external
        nonReentrant
        returns (bytes memory)
    {
        // TODO
    }

    function _extractAmount(bytes calldata data, uint8 idx) internal pure returns (uint256 v) {
        if (idx == NO_AMOUNT) return 0;
        uint256 off = 4 + uint256(idx) * 32;
        require(data.length >= off + 32, "CALLDATA_SHORT");
        assembly {
            v := calldataload(add(data.offset, off))
        }
    }

    function _resolveAddr(bytes32 node) internal view returns (address) {
        // TODO
    }
}
