export interface ScopedCapability {
  node: `0x${string}`;
  capBit: number;
  expiresAt: number;
  token: string;
}

export async function releaseCapability(
  node: `0x${string}`,
  capBit: number,
  ttlSeconds: number,
): Promise<ScopedCapability> {
  throw new Error("todo");
}

export async function revokeCapability(node: `0x${string}`): Promise<void> {
  throw new Error("todo");
}
