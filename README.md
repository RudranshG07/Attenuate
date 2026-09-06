# Attenuate

An AI agent that manages an onchain lending position, and the permission layer that makes it safe to fund. Every agent is an ENSv2 subname whose scope, budget and expiry live in its own resolver, and the subregistry will not mint a subname whose grant is not a subset of its parent's, so an over-privileged agent never exists in the first place. The root mandate is signed once on a Ledger Key Ring, and revoking a parent name kills its entire subtree in the same block.

Built for ETHOnline 2026.
