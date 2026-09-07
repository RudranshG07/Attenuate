import type { Hex, TypedDataDomain } from "viem";

export interface KeyRingOptions {
  speculosUrl?: string;
  relayUrl?: string;
}

export interface TypedDataPayload {
  primaryType: string;
  message: Record<string, unknown>;
}

export async function isDeviceAvailable(o: KeyRingOptions = {}): Promise<boolean> {
  throw new Error("todo");
}

export async function signTypedData(
  domain: TypedDataDomain,
  types: unknown,
  payload: TypedDataPayload,
): Promise<Hex> {
  throw new Error("todo");
}

export async function requestApproval(summary: string): Promise<boolean> {
  throw new Error("todo");
}
