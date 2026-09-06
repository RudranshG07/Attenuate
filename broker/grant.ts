import type { Grant } from "./types.js";

// Legality is decided by AttenuatedSubregistry, not here.
export function encodeRegister(
  parentNode: `0x${string}`,
  label: string,
  owner: `0x${string}`,
  childGrant: Grant,
): `0x${string}` {
  throw new Error("todo");
}

export function encodeRegisterOrLog(
  parentNode: `0x${string}`,
  label: string,
  owner: `0x${string}`,
  childGrant: Grant,
): `0x${string}` {
  throw new Error("todo");
}

export async function simulateGrant(
  parentNode: `0x${string}`,
  childGrant: Grant,
): Promise<{ ok: boolean; reason?: string }> {
  throw new Error("todo");
}
