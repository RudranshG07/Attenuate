// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

contract CapabilityRegistry {
    uint8 public constant NO_AMOUNT = 0xFF;
    uint8 public constant NO_ARG = 0xFF;

    struct CapSpec {
        address target;
        bytes4 selector;
        uint8 amountArgIndex;
        uint32 queryCost;
        bool readSafe;
        bool enabled;
        address pinnedArg;
        uint8 pinnedArgIndex;
    }

    address public immutable BUDGET_ASSET;
    address public owner;

    mapping(uint8 => CapSpec) internal _caps;

    event CapSet(uint8 indexed bit, CapSpec spec);
    event CapDisabled(uint8 indexed bit);

    error NotOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address budgetAsset) {
        BUDGET_ASSET = budgetAsset;
        owner = msg.sender;
    }

    // amountArgIndex is the calldata word carrying the spend, so ERC20 calls can be metered
    // where msg.value is zero. queryCost is charged against the grant's query budget.
    // pinnedArgIndex fixes one address argument, which is what stops a capability whose
    // target and selector are legitimate from being aimed at an arbitrary counterparty.
    function setCap(uint8 bit, CapSpec calldata spec) external onlyOwner {
        CapSpec memory s = spec;
        s.enabled = true;
        if (s.pinnedArgIndex != NO_ARG) {
            require(s.pinnedArg != address(0), "PINNED_ARG_ZERO");
        }
        _caps[bit] = s;
        emit CapSet(bit, s);
    }

    function disableCap(uint8 bit) external onlyOwner {
        _caps[bit].enabled = false;
        emit CapDisabled(bit);
    }

    function caps(uint8 bit) external view returns (CapSpec memory) {
        return _caps[bit];
    }

    function isReadSafe(uint8 bit) external view returns (bool) {
        return _caps[bit].readSafe;
    }
}
