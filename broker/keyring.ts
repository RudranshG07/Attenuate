export interface KeyRingOptions {
  speculosUrl?: string;
  relayUrl?: string;
}

export async function isDeviceAvailable(o: KeyRingOptions = {}): Promise<boolean> {
  throw new Error("todo");
}

export async function signTypedData(
  domain: unknown,
  types: unknown,
  message: unknown,
): Promise<`0x${string}`> {
  throw new Error("todo");
}

export async function requestApproval(summary: string): Promise<boolean> {
  throw new Error("todo");
}
