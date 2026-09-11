// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";

import {GrantStore} from "../src/GrantStore.sol";

// Drives the store through grant, revoke, reclaim and spend in whatever order the fuzzer
// picks. It owns the store so it can authorize a registry per parent, and it is the
// executor so it can spend, which is the whole surface that moves budget.
contract ConservationHandler is CommonBase, StdUtils {
    GrantStore public store;

    uint256 public constant ROOT = 1;

    uint256[] public nodes;
    uint256 public nextNode = 1;

    mapping(uint256 => uint256) public depthOf;
    uint256 public maxDepthSeen;

    uint256 public totalSpent;
    uint256 public totalQuerySpent;

    // Reclaiming a node with no live ancestor left has nowhere to return the remainder,
    // so it leaves the accounting. Tracked here so conservation stays an equality.
    uint256 public totalBurned;
    uint256 public totalQueryBurned;

    uint256 public grants;
    uint256 public revocations;
    uint256 public reclaims;
    uint256 public spends;
    uint256 public warps;

    constructor(address deviceKey) {
        store = new GrantStore(deviceKey);
        store.setExecutor(address(this));
        nodes.push(ROOT);
    }

    function nodeCount() external view returns (uint256) {
        return nodes.length;
    }

    function _registry(uint256 node) internal returns (address a) {
        a = address(uint160(uint256(keccak256(abi.encode("registry", node)))));
        if (!store.isRegistry(a)) {
            store.authorizeRegistry(a, node);
        }
    }

    function _pick(uint256 seed) internal view returns (uint256) {
        return nodes[seed % nodes.length];
    }

    function _pickNonRoot(uint256 seed) internal view returns (uint256) {
        if (nodes.length == 1) return ROOT;
        return nodes[1 + (seed % (nodes.length - 1))];
    }

    function sumSpendRemaining() public view returns (uint256 total) {
        for (uint256 i = 0; i < nodes.length; i++) {
            total += store.grantOf(nodes[i]).spendRemaining;
        }
    }

    function sumQueryRemaining() public view returns (uint256 total) {
        for (uint256 i = 0; i < nodes.length; i++) {
            total += store.grantOf(nodes[i]).queryRemaining;
        }
    }

    function liveSpendRemaining() public view returns (uint256 total) {
        for (uint256 i = 0; i < nodes.length; i++) {
            if (store.isLive(nodes[i])) total += store.grantOf(nodes[i]).spendRemaining;
        }
    }

    function liveQueryRemaining() public view returns (uint256 total) {
        for (uint256 i = 0; i < nodes.length; i++) {
            if (store.isLive(nodes[i])) total += store.grantOf(nodes[i]).queryRemaining;
        }
    }

    function grant(uint256 parentSeed, uint256 capsSeed, uint256 spendSeed, uint256 querySeed, uint256 expirySeed)
        external
    {
        uint256 parent = _pick(parentSeed);
        GrantStore.Grant memory p = store.grantOf(parent);

        if (p.maxDepth == 0 || !store.isLive(parent)) return;

        GrantStore.Grant memory g;
        g.capabilities = capsSeed & p.capabilities;
        g.spendCap = p.spendRemaining == 0 ? 0 : spendSeed % (p.spendRemaining + 1);
        g.queryBudget = p.queryRemaining == 0 ? 0 : querySeed % (p.queryRemaining + 1);
        // Shorter than the parent by a fuzzed margin, so the tree holds a spread of
        // expiries and a warp kills subtrees rather than all of it at once.
        g.expiry = uint64(block.timestamp + 1 + (expirySeed % (p.expiry - block.timestamp)));
        g.maxDepth = p.maxDepth - 1;
        g.readOnly = p.readOnly;

        uint256 child = ++nextNode;
        address reg = _registry(parent);

        vm.prank(reg);
        try store.grantTo(child, address(uint160(child)), g) {
            nodes.push(child);
            grants++;
            depthOf[child] = depthOf[parent] + 1;
            if (depthOf[child] > maxDepthSeen) maxDepthSeen = depthOf[child];
        } catch {}
    }

    function revoke(uint256 nodeSeed) external {
        // Revoking the root is an absorbing state: everything below it dies and the rest
        // of the run has nothing left to explore. Reached occasionally so the path where
        // a reclaim has no live ancestor to return to is still covered.
        uint256 node = nodeSeed % 32 == 0 ? ROOT : _pickNonRoot(nodeSeed);
        try store.revoke(node) {
            revocations++;
        } catch {}
    }

    function warp(uint256 seed) external {
        vm.warp(block.timestamp + 1 + (seed % 10 days));
        warps++;
    }

    function reclaim(uint256 nodeSeed) external {
        uint256 node = _pick(nodeSeed);

        uint256 spendBefore = sumSpendRemaining();
        uint256 queryBefore = sumQueryRemaining();

        try store.reclaim(node) {
            reclaims++;
            uint256 spendAfter = sumSpendRemaining();
            uint256 queryAfter = sumQueryRemaining();
            if (spendBefore > spendAfter) totalBurned += spendBefore - spendAfter;
            if (queryBefore > queryAfter) totalQueryBurned += queryBefore - queryAfter;
        } catch {}
    }

    function spend(uint256 nodeSeed, uint256 amountSeed, uint256 unitsSeed) external {
        uint256 node = _pick(nodeSeed);
        GrantStore.Grant memory g = store.grantOf(node);

        if (!store.isLive(node)) return;

        if (g.spendRemaining != 0) {
            uint256 amount = amountSeed % (g.spendRemaining + 1);
            store.spend(node, amount);
            totalSpent += amount;
            spends++;
        }

        if (g.queryRemaining != 0) {
            uint256 units = unitsSeed % (g.queryRemaining + 1);
            store.spendQuery(node, units);
            totalQuerySpent += units;
        }
    }
}

contract ConservationTest is Test {
    ConservationHandler handler;
    GrantStore store;

    uint256 constant MANDATE = 1000 ether;
    uint256 constant QUERY_MANDATE = 10_000;

    uint256 deviceKey = 0xA11CE;

    function setUp() public {
        handler = new ConservationHandler(vm.addr(deviceKey));
        store = handler.store();

        GrantStore.RootMandate memory m = GrantStore.RootMandate({
            node: handler.ROOT(),
            capabilities: type(uint256).max,
            spendCap: MANDATE,
            queryBudget: QUERY_MANDATE,
            expiry: uint64(block.timestamp + 365 days),
            // Kept under MAX_WALK so liveness never fails closed for depth alone.
            maxDepth: 6,
            nonce: 0
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(deviceKey, store.hashMandate(m));
        store.initRoot(m, abi.encodePacked(r, s, v));

        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = ConservationHandler.grant.selector;
        selectors[1] = ConservationHandler.revoke.selector;
        selectors[2] = ConservationHandler.reclaim.selector;
        selectors[3] = ConservationHandler.spend.selector;
        selectors[4] = ConservationHandler.warp.selector;

        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    // Budget is only ever moved, spent, or stranded. It is never created.
    function invariant_SpendBudgetIsConserved() public view {
        assertEq(
            handler.sumSpendRemaining() + handler.totalSpent() + handler.totalBurned(),
            MANDATE,
            "spend budget was created or lost"
        );
    }

    function invariant_QueryBudgetIsConserved() public view {
        assertEq(
            handler.sumQueryRemaining() + handler.totalQuerySpent() + handler.totalQueryBurned(),
            QUERY_MANDATE,
            "query budget was created or lost"
        );
    }

    // The claim that matters: no reachable state gives the live tree more to spend than
    // the one signature at the root authorised.
    function invariant_LiveTreeNeverExceedsTheMandate() public view {
        assertLe(handler.liveSpendRemaining(), MANDATE);
        assertLe(handler.liveQueryRemaining(), QUERY_MANDATE);
    }

    function invariant_CallSummary() public view {
        console.log("nodes      ", handler.nodeCount());
        console.log("max depth  ", handler.maxDepthSeen());
        console.log("grants     ", handler.grants());
        console.log("revocations", handler.revocations());
        console.log("reclaims   ", handler.reclaims());
        console.log("spends     ", handler.spends());
        console.log("warps      ", handler.warps());
        console.log("spent      ", handler.totalSpent());
        console.log("burned     ", handler.totalBurned());
    }
}
