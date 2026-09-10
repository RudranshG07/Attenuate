import { sepolia } from "viem/chains";

// Source of truth: contracts/lib/contracts-v2/contracts/docs/addresses/sepolia.md
// (ENSv2 Sepolia deployment, 2026-06-29). Earlier redeploys still have bytecode on
// Sepolia; those addresses are kept below as ENSV2_LEGACY for forensics only.
export const ENSV2 = {
  ethRegistry: "0x67b728a792e789a8978b30cf1b3b641f19354b43",
  ethRegistrar: "0xa4449a0dd2b83007553d9b1d28b583a46a805a30",
  rootRegistry: "0x11b5bfbe9078d826b1edbdd1cfc12f5828d9f50c",
  userRegistryImpl: "0x840fa461059862ea466a711e8c98c8de732061c0",
  permissionedResolverImpl: "0x7e4b2d59938930168024201752ee5503df402303",
  verifiableFactory: "0x118bc31a50d559f7015a8da26d54b3b030cdb70f",
  labelStore: "0xb03524289c16424f71802a1794c29c7bd1b9f577",
  // Canonical UpgradableUniversalResolverProxy — same address on mainnet and Sepolia.
  universalResolverProxy: "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe",
  mockUsdc: "0xd3322b29a7bdee707d1684676f149bf41aa3422f",
} as const;

/** Previous Sepolia redeploy that broker/chain.ts used to pin. Still has code, not current. */
export const ENSV2_LEGACY = {
  ethRegistry: "0x1d78834d97c1d7b1a38c1dedbd1a287cfed3971e",
  ethRegistrar: "0x7d1b7f586a62ac3f54b9a396849757814283270b",
  rootRegistry: "0xe7f0d5724f8337e3aa9a9910540341ff4273fed9",
  userRegistryImpl: "0x47b442d0cf617c41cabaff5f02f44dd1e5f72546",
  permissionedResolverImpl: "0xa9d3814ab151bf6e37a427432795371a8361614e",
  verifiableFactory: "0x894bc9cc8ff1ad96b8a288c86a8c71d662c07780",
  labelStore: "0xd7351f76866123a7e49381f38a30a96adba7e855",
  universalResolverProxy: "0xd26f2040d083af1cd2962ba303f4bea0c4faf142",
  mockUsdc: "0xcbfd80f74375c54e545af34788ff465f96f66f05",
} as const;

// viem ships a hardcoded Universal Resolver for Sepolia. Without this override
// every lookup silently resolves against the production deployment.
export const hackathonSepolia = {
  ...sepolia,
  contracts: {
    ...sepolia.contracts,
    ensUniversalResolver: { address: ENSV2.universalResolverProxy },
  },
} as const;
