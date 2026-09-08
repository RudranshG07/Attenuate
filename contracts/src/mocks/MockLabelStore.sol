// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ILabelStore} from "@ensv2/utils/interfaces/ILabelStore.sol";
import {LibLabel} from "@ensv2/utils/LibLabel.sol";

// The real LabelStore pulls in the ENSv1 contracts package. Local dev only.
contract MockLabelStore is ILabelStore {
    mapping(uint256 => string) internal _labels;

    function setLabel(string calldata label) external {
        _labels[LibLabel.withVersion(LibLabel.id(label), 0)] = label;
    }

    function getLabel(uint256 anyId) external view returns (string memory) {
        return _labels[LibLabel.withVersion(anyId, 0)];
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == type(ILabelStore).interfaceId;
    }
}
