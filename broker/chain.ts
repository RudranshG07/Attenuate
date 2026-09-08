import { sepolia } from "viem/chains";

export const ENSV2 = {
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
