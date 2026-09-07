// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

contract CapabilityRegistry {
    uint8 public constant NO_AMOUNT = 0xFF;

    struct CapSpec {
        address target;
        bytes4 selector;
        uint8 amountArgIndex;
        bool readSafe;
        bool enabled;
    }

    address public immutable BUDGET_ASSET;
    address public owner;

    mapping(uint8 => CapSpec) internal _caps;

    event CapSet(uint8 indexed bit, address target, bytes4 selector, uint8 amountArgIndex, bool readSafe);
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

    function setCap(uint8 bit, address target, bytes4 selector, uint8 amountArgIndex, bool readSafe)
        external
        onlyOwner
    {
        _caps[bit] = CapSpec(target, selector, amountArgIndex, readSafe, true);
        emit CapSet(bit, target, selector, amountArgIndex, readSafe);
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
