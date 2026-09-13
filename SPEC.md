# Attenuate — Build Spec

Implementation spec. No strategy, no judging notes. Strategy lives in `attenuate-idea-doc.md`.

**Stack:** Solidity 0.8.26 · Foundry · ENSv2 on Sepolia · TypeScript / Node 20 · Ledger Key Ring CLI (`wallet-cli ring`) · The Graph (own subgraph, Subgraph MCP, Substreams gRPC) · x402 · Next.js + viem

> **DEADLINE: Sunday 13 September 2026, 12:00 pm EDT (9:30 pm IST). Submit Sunday MORNING, 9:30 am IST.**
>
> **Calendar correction:** Sep 13 2026 is a Sunday, so Sep 7 is a **Monday**. The previous plan opened on "Mon 8 Sep", which is a Tuesday. Today (Mon 7 Sep) is Day 1. You have one more working day than the old plan assumed. Do not spend it.
>
> **This file must be committed to the submission repo.** ETHOnline requires that spec-driven workflows include all spec files, prompts and planning artifacts so judges can see how the AI was directed. Keep a `prompts/` directory alongside it and commit as you go.
>
> **Every team member needs real authored commits.** Submissions relying entirely on AI without meaningful team contribution may be ineligible for partner prizes.

---

## 0. Go/no-go — ANSWERED, GREEN (verified 7 Sep against ensdomains/contracts-v2 @ main)

> **`PermissionedRegistry.register()` is `public virtual`.**

A custom registry may inherit `PermissionedRegistry` and override `register`. `UserRegistry.sol` in the ENS repo is the official template for this: it inherits `PermissionedRegistry`, is UUPS-upgradeable, and is deployed as a proxy through `VerifiableFactory`.

The strong claim holds. The naming layer itself refuses to mint an over-privileged child. The weaker "cannot be authorised" fallback is not needed and has been removed from §16.

### What this changed in the design

Three things in the v2 spec were invented and are wrong:

**1. A registry owns exactly one name and its direct children.** There is no `parentNode` argument anywhere, because the registry *is* the parent. `AttenuatedSubregistry` deployed at `attenuate.eth` governs all of `*.attenuate.eth` and nothing else. Depth needs one registry instance per level.

**2. The `register` signature is fixed by `IStandardRegistry` and has no room for a `Grant`.** `roleBitmap` is a `uint256` but its upper 128 bits are reserved for admin roles, so a Grant cannot be smuggled through it.

**3. EAC roles are bit positions, not `keccak256` strings.** See §8.

### Verified interfaces

```solidity
// IStandardRegistry
function register(
    string calldata label,
    address owner,
    IRegistry registry,
    address resolver,
    uint256 roleBitmap,
    uint64 expiry
) external returns (uint256 tokenId);

function setSubregistry(uint256 anyId, IRegistry registry) external;
function setResolver(uint256 anyId, address resolver) external;
function setParent(IRegistry parent, string calldata label) external;
function getExpiry(uint256 anyId) external view returns (uint64);
function renew(uint256 anyId, uint64 newExpiry) external;
function unregister(uint256 anyId) external;

// IRegistry - the minimum for participating in resolution
function getSubregistry(string calldata label) external view returns (IRegistry);
function getResolver(string calldata label) external view returns (address);
function getParent() external view returns (IRegistry parent, string memory label);
```

Note `uint256 tokenId`, not our `bytes32 namehash`. Reconcile the Grant key in §2.

### Sepolia — HACKATHON DEPLOYMENT (use these, not the production docs)

ETHGlobal runs a dedicated ENSv2 deployment. Every address differs from the production docs. Source: https://feature-permres-inode-refact.docs-bao.pages.dev/learn/deployments

```
ETHRegistry                    0x1d78834d97c1d7b1a38c1dedbd1a287cfed3971e
ETHRegistrar                   0x7d1b7f586a62ac3f54b9a396849757814283270b
RootRegistry                   0xe7f0d5724f8337e3aa9a9910540341ff4273fed9
UserRegistryImpl               0x47b442d0cf617c41cabaff5f02f44dd1e5f72546
PermissionedResolverImpl       0xa9d3814ab151bf6e37a427432795371a8361614e
VerifiableFactory              0x894bc9cc8ff1ad96b8a288c86a8c71d662c07780
LabelStore                     0xd7351f76866123a7e49381f38a30a96adba7e855
UniversalResolverV2            0xfea8d4b7fcce0b8765c793d6695eac384aaa458f
UpgradableUniversalResolverProxy 0xd26f2040d083af1cd2962ba303f4bea0c4faf142
PublicResolverV2               0xf9de4979ddb290baf5b760d0e788125017bc33f6
BatchRegistrar                 0xc8efa80d9f645b26bacd1bae8638492df3bae8ca
MockUSDC                       0xcbfd80f74375c54e545af34788ff465f96f66f05
MockDAI                        0x93403a98c3a6be906585cd0d68447c0fc600fb38
```

`LabelStore` is the one our registry constructor needs. `MockUSDC` is the demo budget asset.

**viem and ethers ship a hardcoded Universal Resolver and will silently resolve against the wrong deployment.** Override it once:

```ts
const hackathonSepolia = {
  ...sepolia,
  contracts: {
    ...sepolia.contracts,
    ensUniversalResolver: { address: "0xd26f2040d083af1cd2962ba303f4bea0c4faf142" },
  },
} as const;
```

Note the override uses `UpgradableUniversalResolverProxy`, not `UniversalResolverV2`.

**Registering a name:** the hackathon ENS app is unreliable (gas-limit and payment-quote failures reported by several teams). Register direct-to-contracts with commit-reveal and the MockUSDC fee.

Hackathon explorer: https://hackathon-deployment-portal-app.ens-cf.workers.dev/

Source of truth is `github.com/ensdomains/contracts-v2`, path `contracts/src/registry/`. Read it, do not read a summary of it.

---

## 1. Repo layout

```
contracts/
  src/
    CapabilityRegistry.sol
    AttenuatedSubregistry.sol
    Executor.sol
    interfaces/IENSv2.sol          [UNVERIFIED] — generate from live ABI
  test/
    Attenuation.t.sol              fuzz the invariant
    Escalation.t.sol               the 20 named scenarios
    Revocation.t.sol               epoch + reclaim semantics
    Metering.t.sol                 ERC20 amount extraction
  script/Deploy.s.sol
broker/
  keyring.ts                       wallet-cli ring wrapper
  mandate.ts                       EIP-712 signing
  grant.ts                         builds calldata; does NOT decide legality
  secrets.ts                       releases scoped capability, never a key
keyring-remote/
  enroll.ts                        Key Ring on a host with no USB port
agent/
  monitor.ts                       position health loop
  planner.ts                       LLM proposes a Grant; chain disposes
  decide.ts                        act vs delegate vs escalate
mcp-server/
  index.ts
  SKILL.md
subgraph/
  schema.graphql
  subgraph.yaml
  src/mapping.ts
indexer/
  substreams-trigger.ts            gRPC, cursor resumption, reorg detection
web/
  app/tree/page.tsx
FEEDBACK.md                        Ledger DX notes, write as you go
```

Landing page is cut. See §16.

---

## 2. Data model

```solidity
struct Grant {
    uint256 capabilities;        // bitmask, see CapabilityRegistry
    uint256 spendCap;            // ceiling for this node, in budgetAsset units
    uint256 spendRemaining;      // unallocated + unspent portion
    uint256 queryBudget;         // x402 units
    uint256 queryRemaining;      // unallocated + unspent portion
    uint64  expiry;              // unix seconds
    uint16  maxDepth;            // further delegation hops allowed
    bool    readOnly;
    bool    revoked;             // terminal; prevents double-revoke
    bool    reclaimed;           // terminal; prevents double-refund
    bytes32 parent;              // namehash
    uint64  parentEpochAtGrant;
    uint64  epoch;               // 0 = never granted
}

mapping(bytes32 => Grant) public grants;   // namehash => Grant
bytes32 public constant ROOT = bytes32(0);
uint256 public constant MAX_WALK = 8;
```

**Changed from v1.** `remaining` split into `spendRemaining` / `queryRemaining`, because v1 allocated the spend cap but let two children each take the parent's *full* `queryBudget` — the exact double-spend bug v1 correctly fixed for money and missed for queries. `revoked` and `reclaimed` added, see §5.

### CapabilityRegistry

Bit index → semantic meaning. Keep it small; 8 bits is enough for the demo.

| Bit | Capability | Target constraint | Read-safe |
|---|---|---|---|
| 0 | `swap.uniswap` | Uniswap router only | no |
| 1 | `lend.aave.supply` | Aave pool only | no |
| 2 | `lend.aave.repay` | Aave pool only | no |
| 3 | `lend.aave.withdraw` | Aave pool only | no |
| 4 | `erc20.approve` | allowlisted tokens | no |
| 5 | `transfer.native` | — | no |
| 6 | `data.graph.read` | no onchain target | **yes** |
| 7 | `delegate` | may call `register()` | **yes** |

```solidity
uint8 constant NO_AMOUNT = 0xFF;

struct CapSpec {
    address target;          // only contract this bit may call
    bytes4  selector;        // only function this bit may call
    uint8   amountArgIndex;  // word index of the value-bearing arg, NO_AMOUNT if none
    bool    readSafe;        // may a readOnly grant invoke this bit
    bool    enabled;
}

mapping(uint8 => CapSpec) public caps;
address public immutable budgetAsset;   // address(0) = native ETH
```

**`amountArgIndex` is the fix for the biggest hole in v1.** See §7.

---

## 3. The attenuation invariant — core of the project

```solidity
function _assertAttenuated(Grant memory p, Grant memory c) internal pure {
    require(c.capabilities & p.capabilities == c.capabilities, "SCOPE_WIDENED");
    require(c.spendCap    <= p.spendRemaining, "CAP_EXCEEDS_UNALLOCATED");
    require(c.queryBudget <= p.queryRemaining, "BUDGET_EXCEEDS_UNALLOCATED");
    require(c.expiry      <= p.expiry,         "EXPIRY_EXTENDED");
    require(c.maxDepth     < p.maxDepth,       "DEPTH_EXCEEDED");
    require(!p.readOnly || c.readOnly,         "READONLY_ESCALATION");
}
```

`c & p == c` is the subset test. Any bit the child sets that the parent lacks is dropped by the AND, equality fails, revert.

**`p.spendRemaining`, not `p.spendCap`.** Otherwise a parent holding 100 grants 100 to each of two children. Same reasoning now applies to `queryRemaining`.

**`c.maxDepth < p.maxDepth`** means a parent with `maxDepth == 0` can never grant: `c.maxDepth < 0` is unsatisfiable for uint16, so it reverts `DEPTH_EXCEEDED`. That is the intended leaf condition, not a bug.

**Why a child of ROOT is safe.** `grants[ROOT]` is all zeros, so `_assertAttenuated` against it forces `capabilities == 0`, `spendCap == 0`, and reverts on `maxDepth`. Nothing meaningful can be minted directly under ROOT even if someone holds the role.

### Fuzz test (must pass before anything else)

```solidity
function testFuzz_ChildNeverExceedsParent(Grant memory p, Grant memory c) public {
    vm.assume(_isWellFormed(p) && _isWellFormed(c));
    try this.exposed_assertAttenuated(p, c) {
        assertEq(c.capabilities & p.capabilities, c.capabilities);
        assertLe(c.spendCap,    p.spendRemaining);
        assertLe(c.queryBudget, p.queryRemaining);
        assertLe(c.expiry,      p.expiry);
        assertLt(c.maxDepth,    p.maxDepth);
        if (p.readOnly) assertTrue(c.readOnly);
    } catch {}
}
```

### Conservation invariant (new — this is the one judges cannot argue with)

```solidity
function invariant_TreeNeverExceedsRootMandate() public {
    uint256 total = _sumSpendRemainingOverLiveTree() + _sumSpentOverLiveTree();
    assertLe(total, rootMandateSpendCap);
}
```

Run it as a Foundry stateful invariant with `register`, `revoke`, `reclaim` and `execute` in the handler. If this holds under random sequencing, "the tree can never exceed what the device approved" is a proven statement rather than a claim.

---

## 4. AttenuatedSubregistry

Inherits `PermissionedRegistry`. One instance per level of the tree. The instance at `attenuate.eth` governs `*.attenuate.eth`; to give `risk.attenuate.eth` children of its own, deploy a second instance and `setSubregistry` it onto that name.

**For the demo, deploy two levels.** `attenuate.eth` plus `risk.attenuate.eth`. That is enough to make escalation scenario 4 (grandchild re-adds a bit its parent dropped) a real onchain test rather than a unit test.

### Closing the standard mint path

The inherited `register` cannot carry a `Grant`, so it is disabled outright:

```solidity
function register(string memory, address, IRegistry, address, uint256, uint64)
    public
    pure
    override
    returns (uint256)
{
    revert UseRegisterWithGrant();
}
```

**This is the strong version of the claim.** The standard path is closed, so the only way a name can come into existence under `attenuate.eth` is through the attenuated one. Not "we added a check" but "the ordinary way to mint does not work here."

### The attenuated path

```solidity
function registerWithGrant(
    string calldata label,
    address owner,
    address resolver,
    IRegistry childRegistry,
    Grant calldata childGrant
) external returns (uint256 tokenId) {
    Grant storage p = store.grantOf(address(this));

    _checkRoles(ROOT_RESOURCE, RegistryRolesLib.ROLE_REGISTRAR, msg.sender);
    require(store.isLive(address(this)), "PARENT_DEAD");
    _assertAttenuated(p, childGrant);

    store.allocate(address(this), childGrant.spendCap, childGrant.queryBudget);

    tokenId = super._register(
        label, owner, childRegistry, resolver, _roleBitmapFor(childGrant), childGrant.expiry
    );

    store.setGrant(tokenId, childGrant, address(this));
    _writeGrantToResolver(resolver, tokenId, childGrant);

    emit Granted(tokenId, label, owner, childGrant);
}
```

`_roleBitmapFor` maps our capability model onto ENSv2 roles: a grant without the `delegate` bit gets no `ROLE_REGISTRAR`, so it cannot mint children even if it deploys its own registry.

### GrantStore

Grant state lives in one shared `GrantStore`, not inside each registry instance. Every `AttenuatedSubregistry` in the chain reads and writes the same store, so the invariant and the budget accounting stay in one place instead of scattered across deployments.

```solidity
mapping(uint256 => Grant) grants;        // ENSv2 tokenId => Grant
mapping(address => uint256) nodeOf;      // registry instance => the tokenId it governs
```

Keyed by `uint256 tokenId`, which is what ENSv2 gives us. The v2 spec's `bytes32 namehash` key was invented.

**Requirement, unchanged:** an over-privileged child must be unmintable. Not rejected later, never created.

### `registerOrLog` — the fix for unindexable escalations

A reverted transaction emits no events, so `EscalationBlocked` had no data source and the UI red flash had nothing to render. Real fix:

```solidity
function registerOrLog(
    string calldata label,
    address owner,
    address resolver,
    IRegistry childRegistry,
    Grant calldata childGrant
) external returns (uint256 tokenId, bool ok, string memory reason) {
    try this.registerWithGrant(label, owner, resolver, childRegistry, childGrant) returns (uint256 id) {
        return (id, true, "");
    } catch Error(string memory r) {
        emit EscalationBlocked(msg.sender, label, childGrant, r, block.timestamp);
        return (0, false, r);
    }
}
```

`registerWithGrant` still reverts and stays the enforcement point. `registerOrLog` is what the demo's **Attempt Escalation** button and the LLM planner call, so every blocked attempt lands onchain as an indexed event with its named reason.

---

## 5. Epoch revocation — O(1) subtree kill, lazy reclaim

```solidity
function revoke(bytes32 node) external {
    require(_hasRole(msg.sender, node, ROLE_REVOKE), "NOT_REVOKER");
    Grant storage g = grants[node];
    require(g.epoch != 0, "NOT_GRANTED");
    require(!g.revoked, "ALREADY_REVOKED");
    g.revoked = true;
    g.epoch++;                                    // single SSTORE, kills the subtree
    emit Revoked(node, g.epoch);
}
```

**Changed from v1.** v1 refunded the parent inside `revoke()`. Two bugs: calling `revoke` twice double-credited the parent, and budget already sub-allocated to the now-dead descendants was stranded forever with no path back to the root. Revocation is now pure epoch mechanics; accounting is a separate, permissionless sweep:

```solidity
function reclaim(bytes32 node) external {
    Grant storage g = grants[node];
    require(g.epoch != 0, "NOT_GRANTED");
    require(!isLive(node), "STILL_LIVE");
    require(!g.reclaimed, "ALREADY_RECLAIMED");
    g.reclaimed = true;

    bytes32 anc = _nearestLiveAncestor(node);     // ROOT if none
    uint256 s = g.spendRemaining;
    uint256 q = g.queryRemaining;
    g.spendRemaining = 0;
    g.queryRemaining = 0;
    if (anc != ROOT) {
        grants[anc].spendRemaining += s;
        grants[anc].queryRemaining += q;
    }
    emit Reclaimed(node, anc, s, q);
}
```

Anyone may call `reclaim` on any dead node. Call it once per descendant to sweep a whole subtree back to the nearest survivor. **Revocation stays O(1) and instant; only the bookkeeping is lazy.** Say it that way in the writeup — it is a stronger claim than v1's, not a weaker one.

```solidity
function isLive(bytes32 node) public view returns (bool) {
    bytes32 cur = node;
    for (uint256 i = 0; i < MAX_WALK; i++) {
        if (cur == ROOT) return true;
        Grant storage g = grants[cur];
        if (g.epoch == 0) return false;                                  // never granted
        if (g.revoked) return false;
        if (g.expiry < block.timestamp) return false;
        if (g.parentEpochAtGrant != grants[g.parent].epoch) return false;
        cur = g.parent;
    }
    return false;    // fail closed; v1 reverted, which broke view calls from the UI
}
```

Bumping a parent's epoch invalidates every descendant in the same block, at any depth. `MAX_WALK` = 8; real depth is capped by `maxDepth` at 3–4, so the bound is unreachable in practice and returning `false` on overflow fails closed.

**Test:** grant a 3-level chain, revoke the root, assert every descendant returns `isLive == false` in the same block, and assert `revoke` gas is constant regardless of subtree size.

---

## 6. Executor — use-time enforcement

ENS resolvers **store** records; they do not intercept transactions. Two enforcement points:

| Point | Contract | Stops |
|---|---|---|
| Grant time | `AttenuatedSubregistry.register()` | An over-privileged name existing |
| Use time | `Executor.execute()` | An action outside the resolved Grant |

---

## 7. Metering — the correctness fix that matters most

**The v1 hole.** v1's `execute` metered `value <= g.remaining`. But every action in the demo — Aave repay, Uniswap swap, `erc20.approve` — moves ERC20 tokens with `value == 0`. The spend cap therefore constrained nothing the agent actually did. "Acts inside the budget the device authorised" was not true, and it is the first thing a sharp judge probes.

**The fix.** Each capability declares which calldata word carries its amount. The Executor reads that word and meters it.

```solidity
function _extractAmount(bytes calldata data, uint8 idx) internal pure returns (uint256 v) {
    if (idx == NO_AMOUNT) return 0;
    uint256 off = 4 + uint256(idx) * 32;
    require(data.length >= off + 32, "CALLDATA_SHORT");
    assembly { v := calldataload(add(data.offset, off)) }
}
```

Argument indices for the demo capabilities:

| Capability | Signature | `amountArgIndex` |
|---|---|---|
| `lend.aave.repay` | `repay(address,uint256,uint256,address)` | 1 |
| `lend.aave.supply` | `supply(address,uint256,uint16,address)` | 1 |
| `erc20.approve` | `approve(address,uint256)` | 1 |
| `transfer.native` | — | `NO_AMOUNT` (metered via `value`) |
| `data.graph.read` | — | `NO_AMOUNT` |

**Limitation, stated openly:** this reads a flat uint256 at a fixed word. Struct-encoded params (Uniswap's `exactInputSingle((...))`) need a per-capability decoder. For the demo, pin `swap.uniswap` to a flat-argument router function or drop the bit. Do not fake it.

```solidity
function execute(
    bytes32 node,
    uint8   capBit,
    address target,
    uint256 value,
    bytes calldata data
) external nonReentrant returns (bytes memory) {
    Grant storage g = grants[node];
    CapSpec memory s = capReg.caps(capBit);

    require(msg.sender == _resolveAddr(node), "NOT_AGENT");   // [UNVERIFIED] ENS addr
    require(isLive(node), "REVOKED_OR_EXPIRED");
    require(s.enabled, "CAP_DISABLED");
    require(g.capabilities & (1 << capBit) != 0, "CAP_MISSING");
    require(!g.readOnly || (s.readSafe && value == 0), "READONLY");
    require(data.length >= 4, "CALLDATA_SHORT");
    require(target == s.target, "TARGET_MISMATCH");
    require(bytes4(data[:4]) == s.selector, "SELECTOR_MISMATCH");

    uint256 spend = value + _extractAmount(data, s.amountArgIndex);
    require(spend <= g.spendRemaining, "OVER_BUDGET");

    g.spendRemaining -= spend;                                // effects before interaction
    (bool ok, bytes memory ret) = target.call{value: value}(data);
    require(ok, "CALL_FAILED");
    emit Executed(node, capBit, target, spend);
    return ret;
}
```

**Three further v1 fixes visible here:**

- **`readOnly` now means something.** v1 only checked `value == 0`, so a read-only agent could still call `repay` or `approve` for free. It now requires the capability be flagged `readSafe` in the registry.
- **`nonReentrant`.** Effects precede the interaction, so budget cannot be double-spent, but without a guard a malicious target could re-enter `register()` mid-call and allocate against a budget the executor is in the middle of debiting.
- **`data.length >= 4`.** v1's `bytes4(data)` on short calldata silently zero-pads and could match a zero selector.

---

## 8. ENSv2 integration — VERIFIED

### Setup order

```
1. register attenuate.eth on ENSv2 Sepolia (ETHRegistrar)
2. deploy AttenuatedSubregistry as a UUPS proxy via VerifiableFactory
3. setSubregistry(attenuateTokenId, thatProxy)
4. deploy / point at a PermissionedResolver
5. only now can subnames be created, and only via registerWithGrant
```

Use `ens-cli` for the ENS-side calldata. Do not hand-roll it.

### Roles — bit positions, not keccak strings

From `contracts/src/registry/libraries/RegistryRolesLib.sol`. Admin variants are the same bit shifted left by 128.

| Role | Value | Grants |
|---|---|---|
| `ROLE_REGISTRAR` | `1 << 0` | register / reserve names |
| `ROLE_REGISTER_RESERVED` | `1 << 4` | RESERVED to REGISTERED |
| `ROLE_SET_PARENT` | `1 << 8` | set parent pointer |
| `ROLE_UNREGISTER` | `1 << 12` | delete names |
| `ROLE_RENEW` | `1 << 16` | extend expiry |
| `ROLE_SET_SUBREGISTRY` | `1 << 20` | set the subregistry pointer |
| `ROLE_SET_RESOLVER` | `1 << 24` | set the resolver |
| `ROLE_CAN_TRANSFER_ADMIN` | `(1 << 28) << 128` | transferability |
| `ROLE_SET_URI` | `1 << 36` | token URI |
| `ROLE_CAN_NAME` | `1 << 120` | naming |

**The v2 spec's `ROLE_GRANT` / `ROLE_REVOKE` / `ROLE_BUDGET` / `ROLE_EXTEND` do not exist.** Map onto the real ones:

| We wanted | Real equivalent |
|---|---|
| `ROLE_GRANT` | `ROLE_REGISTRAR` |
| `ROLE_REVOKE` | `ROLE_UNREGISTER`, plus our own epoch bump in `GrantStore` |
| `ROLE_EXTEND` | `ROLE_RENEW`, capped at the parent's expiry by `_assertAttenuated` |
| `ROLE_BUDGET` | ours alone, lives in `GrantStore` |

The split is still real and still demoable: scenario 11 is a holder of `ROLE_UNREGISTER` without `ROLE_REGISTRAR` attempting to mint.

**Non-transferable** comes free: withhold `ROLE_CAN_TRANSFER_ADMIN` and the name cannot be sold. A permission that is not for sale, enforced by the registry.

### Records per agent name

| Record | Value |
|---|---|
| `addr` | Executor address, so any wallet resolves the name |
| `grant.caps` | hex bitmask, text record |
| `grant.cap` | spendCap |
| `grant.remaining` | spendRemaining |
| `grant.budget` | queryBudget |
| `grant.expiry` | unix seconds |
| ENSIP-25 | ERC-8004 identity backlink |

Text records must be readable by any ENS client with no SDK. Test against an external ENS explorer, on camera.

### Still to verify on the resolver

- `PermissionedResolver` text-record write signature. Pull from `contracts/src/resolver/`.
- Wildcard resolution for ephemeral `exec.*` grants.
- Whether `UniversalResolverV2` walks through a custom registry without extra setup.

---

## 9. Ledger Key Ring

### Root mandate — EIP-712

```
RootMandate(
  bytes32 rootNode,
  uint256 capabilities,
  uint256 spendCap,
  uint256 queryBudget,
  uint64  expiry,
  uint16  maxDepth,
  uint256 nonce
)
```

```solidity
function initRoot(RootMandate calldata m, bytes calldata sig) external {
    require(nonces[m.rootNode]++ == m.nonce, "BAD_NONCE");
    require(ECDSA.recover(_hashTypedData(m), sig) == deviceKey, "NOT_DEVICE");
    require(grants[m.rootNode].epoch == 0, "ROOT_EXISTS");
    Grant storage g = grants[m.rootNode];
    g.capabilities   = m.capabilities;
    g.spendCap       = m.spendCap;
    g.spendRemaining = m.spendCap;
    g.queryBudget    = m.queryBudget;
    g.queryRemaining = m.queryBudget;
    g.expiry         = m.expiry;
    g.maxDepth       = m.maxDepth;
    g.parent         = ROOT;
    g.epoch          = 1;
}
```

### Three device touchpoints — all required

1. **Root mandate** — one EIP-712 signature
2. **Secret release** — every capability handed to a sub-agent is released from the Key Ring. The agent never receives a raw key. `broker/secrets.ts`.
3. **Escalation** — an attempt to exceed scope surfaces as a device signature prompt, not a silent revert

### Remote enrollment (`keyring-remote/`)

The agent runs on a VPS with no USB port; the device is elsewhere. Build the enrollment and approval channel.

**Hard timebox: 4 hours on Day 3.** If the Key Ring transport blocks it, stop, fall back to a signed-approval relay, and write the blocker up in `FEEDBACK.md` with reproduction steps and version. A documented failure still scores on DX. An undocumented two-day rabbit hole costs you the Graph leg.

### FEEDBACK.md

Write it continuously, not at the end. Every rough edge in the Key Ring CLI: what you ran, what you expected, what happened, version, OS.

---

## 10. The agent — constrained planning `[the Graph leg lives here]`

**The v1 problem.** v1's agent was: read health, if below threshold, delegate. That is an if-statement. For a track called *Best AI Tooling or AI Use Case*, "it compares a number to a constant" is not an AI use case, and it was the weakest part of the submission.

**The fix — the model proposes, the chain disposes.**

```
1. Substreams push -> position health changed
2. Read position via Subgraph MCP (pay x402 from Grant.queryRemaining)
3. LLM planner (agent/planner.ts) receives the position and the parent Grant,
   and returns a proposed child Grant: which capability bits, what spendCap,
   what expiry, what depth.
4. Broker submits it through registerOrLog().
   - within scope -> subname minted, sub-agent spawned as its own process
   - outside scope -> EscalationBlocked emitted with the named reason, indexed,
                      red flash in the UI, device signature prompt raised
5. Child executes via Executor, reports, parent revokes the child name
```

This is a strictly better story on every axis:

- **It is a real AI use case.** An unconstrained model proposes privileged actions; the registry is the thing that makes that safe. That is the agent-safety argument the whole industry is currently having, demonstrated rather than asserted.
- **It produces the headline number.** Log every proposal. `N grants proposed by the model, M outside scope, M blocked at mint time, 0 escalations reached execution.` The Graph track's Lisbon winner won on a measurement. This is yours, and it is generated by the system rather than staged.
- **It makes the failure mode the demo.** You no longer need to hand-author an escalation attempt for the video. Run the planner with a deliberately loose prompt and it will produce one on its own.

**Sub-agents are separate processes with their own keys resolving to their own names. They must not be function calls with names attached.** A judge will check this. This is the single risk that loses all three tracks.

---

## 11. The Graph

### 11.1 Own subgraph (`subgraph/`)

Index the permission tree itself.

```graphql
type Agent @entity {
  id: ID!                    # namehash
  name: String!
  parent: Agent
  children: [Agent!]! @derivedFrom(field: "parent")
  capabilities: BigInt!
  spendCap: BigInt!
  spendRemaining: BigInt!
  queryBudget: BigInt!
  queryRemaining: BigInt!
  expiry: BigInt!
  depth: Int!
  epoch: BigInt!
  revoked: Boolean!
  reclaimed: Boolean!
  createdAt: BigInt!
}

type Escalation @entity {
  id: ID!
  parent: Agent!
  attemptedBy: Bytes!
  label: String!
  reason: String!            # SCOPE_WIDENED, CAP_EXCEEDS_UNALLOCATED, ...
  proposedBy: String!        # "llm-planner" | "manual"
  blockNumber: BigInt!
  timestamp: BigInt!
}

type BudgetFlow @entity {
  id: ID!
  from: Agent!
  to: Agent
  amount: BigInt!
  kind: String!              # ALLOCATE | SPEND | RECLAIM
  timestamp: BigInt!
}
```

Handlers: `Granted`, `Revoked`, `Reclaimed`, `Executed`, `EscalationBlocked`.

`EscalationBlocked` is now genuinely emitted (§4), so this entity has a real data source. In v1 it did not.

**Fallback if Day 4 slips:** ship a minimal schema indexing only `Granted` and `Revoked`. An indexed subgraph beats a perfect unindexed one.

### 11.2 Substreams trigger (`indexer/`)

gRPC subscription with cursor resumption. **Not polling.**

- Persist the cursor; resume from it on restart
- On `BlockUndoSignal`, **detect** the reorg, mark affected agent state stale, and surface a reorg banner in the UI
- Rationale for the writeup: a guard five minutes late is a preference for an app that displays and a bug for one that spends

**Scoped down from v1.** v1 specified full state rollback to the last irreversible block. That is a day of work for the track with the worst odds. Detection plus a visible stale-state banner demonstrates the same understanding at a fraction of the cost. If Day 4 finishes early, add the rollback.

### 11.3 x402 metered budget

```
agent -> gated Graph endpoint
     <- 402 Payment Required
agent -> pay from Grant.queryRemaining (debited onchain)
     <- data
```

The budget spent on data is the budget the device authorised. Same object. Debit `queryRemaining` on the Grant, not a separate counter. This is mandatory, not optional — without it the Graph leg is generic.

### 11.4 MCP server (`mcp-server/`) — the primary Graph deliverable

Reusable infrastructure, not a wrapper around the demo. Any agent in any framework must be able to use it without seeing this project.

Tools: `grant_capability`, `revoke_agent`, `check_scope`, `query_position`, `get_delegation_tree`, `simulate_grant`.

`simulate_grant` is new and is the one an external developer actually wants: hand it a parent node and a proposed Grant, get back the named reason it would be refused, without spending gas.

Ship `SKILL.md` alongside. **This, not the agent, is the Graph pitch.** The track rewards reusable infrastructure over a single end-user app.

### 11.5 Benchmark

| Metric | Method |
|---|---|
| Trigger lag: Substreams vs polling | 100 blocks, both running in parallel |
| Missed events | Liquidation-threshold crossings polling would have missed |
| LLM grant proposals blocked | Count from `EscalationBlocked`, over the demo run |

---

## 12. Test suite — these numbers get published

`test/Escalation.t.sol` — all 20 must revert with the named reason. v1 had 12; the eight added cover the bugs fixed in this revision.

| # | Attack | Expected revert |
|---|---|---|
| 1 | Child sets a capability bit parent lacks | `SCOPE_WIDENED` |
| 2 | Child spendCap > parent spendRemaining | `CAP_EXCEEDS_UNALLOCATED` |
| 3 | Child expiry beyond parent | `EXPIRY_EXTENDED` |
| 4 | Grandchild re-adds a bit its parent dropped | `SCOPE_WIDENED` |
| 5 | Child de-escalates readOnly | `READONLY_ESCALATION` |
| 6 | Delegate past maxDepth | `DEPTH_EXCEEDED` |
| 7 | Execute after root revoked | `REVOKED_OR_EXPIRED` |
| 8 | Two children each granted the full parent budget | second reverts |
| 9 | Non-agent address calls execute | `NOT_AGENT` |
| 10 | Valid cap bit, wrong target | `TARGET_MISMATCH` |
| 11 | `ROLE_REVOKE` holder attempts to grant | `NOT_GRANTOR` |
| 12 | Grant under an already-revoked parent | `PARENT_DEAD` |
| **13** | **ERC20 repay amount in calldata exceeds budget** | **`OVER_BUDGET`** |
| **14** | **readOnly grant invokes a non-read-safe capability** | **`READONLY`** |
| **15** | **Two children each granted the full parent queryBudget** | **`BUDGET_EXCEEDS_UNALLOCATED`** |
| **16** | **`revoke` called twice on the same node** | **`ALREADY_REVOKED`** |
| **17** | **`reclaim` on a still-live node** | **`STILL_LIVE`** |
| **18** | **`reclaim` called twice** | **`ALREADY_RECLAIMED`** |
| **19** | **Malicious target re-enters `register` during `execute`** | **reentrancy guard** |
| **20** | **`execute` with calldata shorter than 4 bytes** | **`CALLDATA_SHORT`** |

Scenarios 13, 14 and 15 each corresponded to a real hole in v1. Say so in the README — a project that publishes the bugs it found in its own design reads as engineering, not marketing.

Also record: max delegation depth, gas per grant, gas per revocation, root-to-leaf revocation latency, Substreams trigger lag vs polling, LLM proposals blocked.

---

## 13. Web (`web/`) — one screen, build last

- **Center:** the tree. Nodes are **names, never hex addresses**. Each shows capability chips and a remaining-budget bar. States: alive (solid), working (pulse), rejected (red flash), dead (grey + struck through).
- **Right rail:** transaction feed, every event with the tx hash linked to Sepolia Etherscan.
- **Top:** one input — type a name, see its subtree.
- **Bottom:** three buttons — Grant · Attempt Escalation · Revoke Root.
- **Node detail:** link to resolve the name in an external ENS client.
- **Reorg banner:** when the Substreams trigger reports `BlockUndoSignal`, show it.

Drive everything off contract event subscriptions plus the subgraph. Seed from chain state on load so a refresh does not reset the demo.

**Excluded:** login, settings, wizards, charts, sidebar nav, dark-mode toggle, animations, landing page.

---

## 14. Submission artifacts (required by ETHOnline rules)

| File | Purpose |
|---|---|
| `SPEC.md` | This file. Required in-repo for spec-driven workflows. |
| `prompts/` | Prompts and planning artifacts used to direct the AI. Required. |
| `AI-USE.md` | Which files/directories were AI-assisted and how. Required. |
| `FEEDBACK.md` | Ledger DX notes, written continuously. |
| `SKILL.md` | In `mcp-server/`, published and usable standalone. |
| `README.md` | Setup, architecture, metrics table, prior art, known limitations, ours vs libraries. |

---

## 15. Definition of done

Ordered by what you lose if it is missing. Everything above the line is the minimum winning submission.

- [ ] ENSv2 custom-subregistry go/no-go answered and recorded
- [ ] Fuzz test on the attenuation invariant passes
- [ ] Conservation invariant passes under stateful fuzzing
- [ ] All 20 escalation scenarios revert with the correct reason
- [ ] ERC20 amounts metered against `spendRemaining`, not just `value`
- [ ] Root revocation kills a 3-level tree in one transaction, constant gas
- [ ] A real subname exists on ENSv2 Sepolia with Grant data in its resolver
- [ ] That name's permissions are readable in an external ENS explorer
- [ ] Root mandate signed on a physical device or Speculos
- [ ] Sub-agent receives a scoped capability, never a key
- [ ] Own subgraph deployed and indexing, `EscalationBlocked` included
- [ ] x402 debits `Grant.queryRemaining`
- [ ] MCP server usable standalone, `SKILL.md` published
- [ ] LLM planner proposes grants; blocked-proposal count recorded
- [ ] Web tree renders live from chain events
- [ ] Demo video: 2–4 min, 720p+, human narration, not phone-recorded, not sped up
- [ ] `SPEC.md`, `prompts/`, `AI-USE.md` committed
- [ ] Small frequent commits from all three people

--- everything below is upside ---

- [ ] Wildcard resolution for an ephemeral agent
- [ ] Non-transferable flag on all agent names
- [ ] Split EAC roles exercised, not just declared
- [ ] Remote enrollment working on a VPS with no USB port (4h timebox)
- [ ] Substreams cursor resumption
- [ ] Reorg detection + stale banner
- [ ] Benchmark: Substreams vs polling lag, missed events
- [ ] Three partner write-ups drafted

---

## 16. Known limitations — state these, do not hide them

A judge finds these in ninety seconds. Finding them in your README instead reads as rigour.

1. **Single budget asset.** `spendCap` is denominated in one `budgetAsset`. Multi-asset budgets need per-asset `remaining` mappings and a price oracle for cross-asset attenuation. Out of scope for six days.
2. **Flat-argument metering only.** `amountArgIndex` reads a uint256 at a fixed calldata word. Struct-encoded params need a per-capability decoder.
3. **Reclaim is manual.** Sweeping a large dead subtree is one call per node. A batched sweep is straightforward but unbuilt.
4. **`MAX_WALK` caps depth at 8.** Beyond it `isLive` fails closed. `maxDepth` already caps real depth at 3–4.
5. **Executor holds the funds.** A production design would use per-agent accounts. The permission model is unchanged either way.

### §0 go/no-go: resolved

Answered 7 Sep, green. `PermissionedRegistry.register` is `public virtual`, so mint-time refusal is real and the fallback that used to live here is deleted. Ship the strong claim.

---

## Reference

- ENSv2 — https://docs.ens.domains/ensv2/overview
- Enhanced Access Control — https://docs.ens.domains/ensv2/enhanced-access-control
- Permissioned Resolver — https://docs.ens.domains/ensv2/permissioned-resolver
- Permissioned Registry — https://docs.ens.domains/ensv2/permissioned-registry
- `ens-cli` — https://github.com/ensdomains/ens-cli
- Ledger ETHOnline — https://developers.ledger.com/ethonline
- Subgraph MCP — https://thegraph.com/docs/en/subgraphs/tooling/subgraph-mcp/introduction/
- Subgraph SKILLs — https://github.com/graphprotocol/subgraphs-skills
