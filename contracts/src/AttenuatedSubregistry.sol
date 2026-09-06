// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IENSv2} from "./interfaces/IENSv2.sol";

contract AttenuatedSubregistry {
    struct Grant {
        uint256 capabilities;
        uint256 spendCap;
        uint256 spendRemaining;
        uint256 queryBudget;
        uint256 queryRemaining;
        uint64 expiry;
        uint16 maxDepth;
        bool readOnly;
        bool revoked;
        bool reclaimed;
        bytes32 parent;
        uint64 parentEpochAtGrant;
        uint64 epoch;
    }

    struct RootMandate {
        bytes32 rootNode;
        uint256 capabilities;
        uint256 spendCap;
        uint256 queryBudget;
        uint64 expiry;
        uint16 maxDepth;
        uint256 nonce;
    }

    bytes32 public constant ROOT = bytes32(0);
    uint256 public constant MAX_WALK = 8;

    bytes32 public constant ROLE_GRANT = keccak256("ROLE_GRANT");
    bytes32 public constant ROLE_REVOKE = keccak256("ROLE_REVOKE");
    bytes32 public constant ROLE_BUDGET = keccak256("ROLE_BUDGET");
    bytes32 public constant ROLE_EXTEND = keccak256("ROLE_EXTEND");

    mapping(bytes32 => Grant) public grants;
    mapping(bytes32 => uint256) public nonces;

    address public deviceKey;

    event Granted(bytes32 indexed parentNode, bytes32 indexed childNode, string label, address owner, Grant grant);
    event Revoked(bytes32 indexed node, uint64 newEpoch);
    event Reclaimed(bytes32 indexed node, bytes32 indexed toAncestor, uint256 spend, uint256 query);
    event EscalationBlocked(
        bytes32 indexed parentNode,
        address indexed attemptedBy,
        string label,
        Grant proposed,
        string reason,
        uint256 timestamp
    );

    function initRoot(RootMandate calldata m, bytes calldata sig) external {
        // TODO
    }

    function _assertAttenuated(Grant memory p, Grant memory c) internal pure {
        require(c.capabilities & p.capabilities == c.capabilities, "SCOPE_WIDENED");
        require(c.spendCap <= p.spendRemaining, "CAP_EXCEEDS_UNALLOCATED");
        require(c.queryBudget <= p.queryRemaining, "BUDGET_EXCEEDS_UNALLOCATED");
        require(c.expiry <= p.expiry, "EXPIRY_EXTENDED");
        require(c.maxDepth < p.maxDepth, "DEPTH_EXCEEDED");
        require(!p.readOnly || c.readOnly, "READONLY_ESCALATION");
    }

    function register(bytes32 parentNode, string calldata label, address owner, Grant calldata childGrant)
        external
        returns (bytes32 childNode)
    {
        // TODO
    }

    function registerOrLog(bytes32 parentNode, string calldata label, address owner, Grant calldata childGrant)
        external
        returns (bytes32 childNode, bool ok, string memory reason)
    {
        // TODO
    }

    function revoke(bytes32 node) external {
        // TODO
    }

    function reclaim(bytes32 node) external {
        // TODO
    }

    function isLive(bytes32 node) public view returns (bool) {
        bytes32 cur = node;
        for (uint256 i = 0; i < MAX_WALK; i++) {
            if (cur == ROOT) return true;
            Grant storage g = grants[cur];
            if (g.epoch == 0) return false;
            if (g.revoked) return false;
            if (g.expiry < block.timestamp) return false;
            if (g.parentEpochAtGrant != grants[g.parent].epoch) return false;
            cur = g.parent;
        }
        return false;
    }

    function _nearestLiveAncestor(bytes32 node) internal view returns (bytes32) {
        // TODO
    }

    function _hasRole(address who, bytes32 node, bytes32 role) internal view returns (bool) {
        // TODO
    }

    function _mintSubname(bytes32 parentNode, string calldata label, address owner) internal {
        // TODO
    }

    function _writeGrantToResolver(bytes32 node, Grant storage g) internal {
        // TODO
    }
}
