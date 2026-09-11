# 01 — Research ENSv2 against source, not docs

## Direction given

> Everything marked UNVERIFIED must be confirmed against live ENSv2 contracts before
> implementation. ENSv2 is three months old. Do not invent function signatures. Pull
> real ABIs and read `ens-cli` source. If a signature conflicts with the real ABI,
> the real ABI wins — update the spec.

## Why it was worth the time

The published docs, web search, and the contract source disagreed with each other.
Search returned `register(bytes32 label, ...)`; the docs said `string label`; the
source says `string memory label`. More importantly, **no documentation page anywhere
states that `register` is `virtual`**, and that single keyword is what decides whether
mint-time refusal is possible at all.

The approach that worked was cloning `ensdomains/contracts-v2` and grepping it.

## What it turned up

- `PermissionedRegistry.register` is `public virtual`, so it can be inherited and
  overridden. The whole project rests on this.
- A registry owns exactly one name and its direct children, so there is no
  `parentNode` argument anywhere. Depth costs deployments.
- Names are `uint256` ERC1155 token ids, not `bytes32` namehashes.
- EAC roles are bit positions (`ROLE_REGISTRAR = 1 << 0`), not `keccak256` strings.
  Our first spec had invented `ROLE_GRANT` / `ROLE_REVOKE` constants that do not exist.
- The role check reverts with `EACUnauthorizedAccountRoles`, not a string. Our spec
  had written `NOT_GRANTOR`, which appears nowhere in the codebase.
- ETHGlobal runs a separate ENSv2 deployment whose addresses differ from the
  production docs, and those addresses changed mid-hackathon.

## Same approach, Ledger

Direction: find out whether Speculos works before assuming it doesn't.

`wallet-cli ring` turned out to be `init | encrypt | decrypt | keys | destroy` —
secret encryption, no signing. EIP-712 lives in a different package entirely
(`@ledgerhq/device-signer-kit-ethereum`). There is a first-class DMK Speculos
transport, and once blind signing is enabled the emulator signs a real EIP-712
mandate that recovers to the device address. `scripts/speculos.sh` is that recipe.
