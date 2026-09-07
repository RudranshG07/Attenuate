import type { Address, Hex, TypedDataDomain } from "viem";

export const DEFAULT_PATH = "44'/60'/0'/0/0";

export interface TypedDataRequest {
  domain: TypedDataDomain;
  types: Record<string, readonly { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

export async function getAddress(path = DEFAULT_PATH): Promise<Address> {
  throw new Error("todo: DeviceManagementKit + signer-kit-ethereum getAddress");
}

export async function signTypedData(
  req: TypedDataRequest,
  path = DEFAULT_PATH,
): Promise<Hex> {
  throw new Error("todo: signerEth.signTypedData, observable -> promise");
}
