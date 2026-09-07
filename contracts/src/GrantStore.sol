// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

contract GrantStore is EIP712 {
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
        uint256 parent;
        uint64 parentEpochAtGrant;
        uint64 epoch;
    }

    struct RootMandate {
        uint256 node;
        uint256 capabilities;
        uint256 spendCap;
        uint256 queryBudget;
        uint64 expiry;
        uint16 maxDepth;
        uint256 nonce;
    }

    bytes32 private constant ROOT_MANDATE_TYPEHASH = keccak256(
        "RootMandate(uint256 node,uint256 capabilities,uint256 spendCap,uint256 queryBudget,uint64 expiry,uint16 maxDepth,uint256 nonce)"
    );

    uint256 public constant MAX_WALK = 8;

    address public owner;
    address public executor;
    address public deviceKey;

    mapping(uint256 => uint256) public nonces;

    mapping(uint256 => Grant) public grants;
    mapping(address => bool) public isRegistry;
    mapping(address => uint256) public nodeOf;

    event RootInitialised(uint256 indexed node, Grant grant);
    event Granted(uint256 indexed parent, uint256 indexed child, Grant grant);
    event Revoked(uint256 indexed node, uint64 epoch);
    event Reclaimed(uint256 indexed node, uint256 indexed toAncestor, uint256 spend, uint256 query);
    event Spent(uint256 indexed node, uint256 amount);
    event QuerySpent(uint256 indexed node, uint256 units);

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    constructor(address _deviceKey) EIP712("Attenuate", "1") {
        owner = msg.sender;
        deviceKey = _deviceKey;
    }

    function hashMandate(RootMandate calldata m) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ROOT_MANDATE_TYPEHASH,
                    m.node,
                    m.capabilities,
                    m.spendCap,
                    m.queryBudget,
                    m.expiry,
                    m.maxDepth,
                    m.nonce
                )
            )
        );
    }

    function setExecutor(address e) external onlyOwner {
        executor = e;
    }

    function authorizeRegistry(address registry, uint256 node) external onlyOwner {
        require(node != 0, "BAD_NODE");
        isRegistry[registry] = true;
        nodeOf[registry] = node;
    }

    function initRoot(RootMandate calldata m, bytes calldata sig) external {
        require(m.node != 0, "BAD_NODE");
        require(nonces[m.node]++ == m.nonce, "BAD_NONCE");
        require(ECDSA.recover(hashMandate(m), sig) == deviceKey, "NOT_DEVICE");
        require(grants[m.node].epoch == 0, "ROOT_EXISTS");

        Grant storage r = grants[m.node];
        r.capabilities = m.capabilities;
        r.spendCap = m.spendCap;
        r.spendRemaining = m.spendCap;
        r.queryBudget = m.queryBudget;
        r.queryRemaining = m.queryBudget;
        r.expiry = m.expiry;
        r.maxDepth = m.maxDepth;
        r.epoch = 1;

        emit RootInitialised(m.node, r);
    }

    function _assertAttenuated(Grant memory p, Grant memory c) internal pure {
        require(c.capabilities & p.capabilities == c.capabilities, "SCOPE_WIDENED");
        require(c.spendCap <= p.spendRemaining, "CAP_EXCEEDS_UNALLOCATED");
        require(c.queryBudget <= p.queryRemaining, "BUDGET_EXCEEDS_UNALLOCATED");
        require(c.expiry <= p.expiry, "EXPIRY_EXTENDED");
        require(c.maxDepth < p.maxDepth, "DEPTH_EXCEEDED");
        require(!p.readOnly || c.readOnly, "READONLY_ESCALATION");
    }

    function grantTo(uint256 childNode, Grant calldata g) external {
        require(isRegistry[msg.sender], "NOT_REGISTRY");
        require(childNode != 0, "BAD_NODE");

        uint256 parentNode = nodeOf[msg.sender];
        require(isLive(parentNode), "PARENT_DEAD");
        require(grants[childNode].epoch == 0, "EXISTS");

        Grant storage p = grants[parentNode];
        _assertAttenuated(p, g);

        p.spendRemaining -= g.spendCap;
        p.queryRemaining -= g.queryBudget;

        Grant storage c = grants[childNode];
        c.capabilities = g.capabilities;
        c.spendCap = g.spendCap;
        c.spendRemaining = g.spendCap;
        c.queryBudget = g.queryBudget;
        c.queryRemaining = g.queryBudget;
        c.expiry = g.expiry;
        c.maxDepth = g.maxDepth;
        c.readOnly = g.readOnly;
        c.parent = parentNode;
        c.parentEpochAtGrant = p.epoch;
        c.epoch = 1;

        emit Granted(parentNode, childNode, c);
    }

    function revoke(uint256 node) external {
        require(isRegistry[msg.sender] || msg.sender == owner, "NOT_REVOKER");
        Grant storage g = grants[node];
        require(g.epoch != 0, "NOT_GRANTED");
        require(!g.revoked, "ALREADY_REVOKED");
        g.revoked = true;
        g.epoch++;
        emit Revoked(node, g.epoch);
    }

    function reclaim(uint256 node) external {
        Grant storage g = grants[node];
        require(g.epoch != 0, "NOT_GRANTED");
        require(!isLive(node), "STILL_LIVE");
        require(!g.reclaimed, "ALREADY_RECLAIMED");

        g.reclaimed = true;
        uint256 s = g.spendRemaining;
        uint256 q = g.queryRemaining;
        g.spendRemaining = 0;
        g.queryRemaining = 0;

        uint256 anc = _nearestLiveAncestor(node);
        if (anc != 0) {
            grants[anc].spendRemaining += s;
            grants[anc].queryRemaining += q;
        }

        emit Reclaimed(node, anc, s, q);
    }

    function spend(uint256 node, uint256 amount) external {
        require(msg.sender == executor, "NOT_EXECUTOR");
        Grant storage g = grants[node];
        require(amount <= g.spendRemaining, "OVER_BUDGET");
        g.spendRemaining -= amount;
        emit Spent(node, amount);
    }

    function spendQuery(uint256 node, uint256 units) external {
        require(msg.sender == executor, "NOT_EXECUTOR");
        Grant storage g = grants[node];
        require(units <= g.queryRemaining, "OVER_QUERY_BUDGET");
        g.queryRemaining -= units;
        emit QuerySpent(node, units);
    }

    function isLive(uint256 node) public view returns (bool) {
        uint256 cur = node;
        for (uint256 i = 0; i < MAX_WALK; i++) {
            Grant storage g = grants[cur];
            if (g.epoch == 0) return false;
            if (g.revoked) return false;
            if (g.expiry < block.timestamp) return false;
            if (g.parent == 0) return true;
            if (g.parentEpochAtGrant != grants[g.parent].epoch) return false;
            cur = g.parent;
        }
        return false;
    }

    function grantOf(uint256 node) external view returns (Grant memory) {
        return grants[node];
    }

    function depthOf(uint256 node) external view returns (uint256) {
        uint256 cur = node;
        for (uint256 i = 0; i < MAX_WALK; i++) {
            uint256 p = grants[cur].parent;
            if (p == 0) return i;
            cur = p;
        }
        return MAX_WALK;
    }

    function _nearestLiveAncestor(uint256 node) internal view returns (uint256) {
        uint256 cur = grants[node].parent;
        for (uint256 i = 0; i < MAX_WALK; i++) {
            if (cur == 0) return 0;
            if (isLive(cur)) return cur;
            cur = grants[cur].parent;
        }
        return 0;
    }
}
