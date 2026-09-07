// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CapabilityRegistry} from "./CapabilityRegistry.sol";
import {GrantStore} from "./GrantStore.sol";

contract Executor {
    GrantStore public immutable STORE;
    CapabilityRegistry public immutable CAPS;

    uint8 internal constant NO_AMOUNT = 0xFF;

    uint256 private _lock = 1;

    event Executed(uint256 indexed node, uint8 indexed capBit, address target, uint256 spend);

    modifier nonReentrant() {
        _enter();
        _;
        _lock = 1;
    }

    constructor(GrantStore store, CapabilityRegistry caps) {
        STORE = store;
        CAPS = caps;
    }

    function execute(uint256 node, uint8 capBit, address target, uint256 value, bytes calldata data)
        external
        nonReentrant
        returns (bytes memory)
    {
        require(msg.sender == STORE.agentOf(node), "NOT_AGENT");
        require(STORE.isLive(node), "REVOKED_OR_EXPIRED");

        CapabilityRegistry.CapSpec memory s = CAPS.caps(capBit);
        require(s.enabled, "CAP_DISABLED");

        GrantStore.Grant memory g = STORE.grantOf(node);
        require(g.capabilities & (1 << capBit) != 0, "CAP_MISSING");
        require(!g.readOnly || (s.readSafe && value == 0), "READONLY");

        require(data.length >= 4, "CALLDATA_SHORT");
        require(target == s.target, "TARGET_MISMATCH");
        require(bytes4(data[:4]) == s.selector, "SELECTOR_MISMATCH");

        uint256 spend = value + _extractAmount(data, s.amountArgIndex);
        STORE.spend(node, spend);

        (bool ok, bytes memory ret) = target.call{value: value}(data);
        require(ok, "CALL_FAILED");

        emit Executed(node, capBit, target, spend);
        return ret;
    }

    function _extractAmount(bytes calldata data, uint8 idx) internal pure returns (uint256 v) {
        if (idx == NO_AMOUNT) return 0;
        uint256 off = 4 + uint256(idx) * 32;
        require(data.length >= off + 32, "CALLDATA_SHORT");
        assembly {
            v := calldataload(add(data.offset, off))
        }
    }

    function _enter() internal {
        require(_lock == 1, "REENTRANT");
        _lock = 2;
    }

    receive() external payable {}
}
