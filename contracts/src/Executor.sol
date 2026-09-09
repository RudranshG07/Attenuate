// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CapabilityRegistry} from "./CapabilityRegistry.sol";
import {GrantStore} from "./GrantStore.sol";

contract Executor {
    GrantStore public immutable STORE;
    CapabilityRegistry public immutable CAPS;

    uint8 internal constant NO_AMOUNT = 0xFF;
    uint8 internal constant NO_ARG = 0xFF;

    address public owner;

    uint256 private _lock = 1;

    event Executed(uint256 indexed node, uint8 indexed capBit, address target, uint256 spend, uint32 queryCost);
    event AllowanceSet(address indexed token, address indexed spender, uint256 amount);

    modifier nonReentrant() {
        _enter();
        _;
        _lock = 1;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    constructor(GrantStore store, CapabilityRegistry caps) {
        STORE = store;
        CAPS = caps;
        owner = msg.sender;
    }

    // The executor holds the budget asset, so a pool it repays needs an allowance. Setting
    // it here rather than through a capability keeps agents from choosing the spender.
    function setAllowance(address token, address spender, uint256 amount) external onlyOwner {
        IERC20(token).approve(spender, amount);
        emit AllowanceSet(token, spender, amount);
    }

    function sweep(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            require(ok, "SWEEP_FAILED");
        } else {
            IERC20(token).transfer(to, amount);
        }
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

        if (s.pinnedArgIndex != NO_ARG) {
            require(_extractAddress(data, s.pinnedArgIndex) == s.pinnedArg, "ARG_MISMATCH");
        }

        uint256 spend = value + _extractAmount(data, s.amountArgIndex);
        STORE.spend(node, spend);
        if (s.queryCost != 0) STORE.spendQuery(node, s.queryCost);

        (bool ok, bytes memory ret) = target.call{value: value}(data);
        require(ok, "CALL_FAILED");

        emit Executed(node, capBit, target, spend, s.queryCost);
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

    function _extractAddress(bytes calldata data, uint8 idx) internal pure returns (address) {
        uint256 off = 4 + uint256(idx) * 32;
        require(data.length >= off + 32, "CALLDATA_SHORT");
        uint256 v;
        assembly {
            v := calldataload(add(data.offset, off))
        }
        require(v >> 160 == 0, "ARG_NOT_ADDRESS");
        return address(uint160(v));
    }

    function _enter() internal {
        require(_lock == 1, "REENTRANT");
        _lock = 2;
    }

    receive() external payable {}
}
