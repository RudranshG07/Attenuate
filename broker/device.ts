import {
  DeviceActionStatus,
  DeviceManagementKitBuilder,
  DeviceModelId,
} from "@ledgerhq/device-management-kit";
import { speculosTransportFactory } from "@ledgerhq/device-transport-kit-speculos";
import { SignerEthBuilder } from "@ledgerhq/device-signer-kit-ethereum";
import { firstValueFrom } from "rxjs";
import type { Address, Hex, TypedDataDomain } from "viem";

export const DEFAULT_PATH = "44'/60'/0'/0/0";

export interface TypedDataRequest {
  domain: TypedDataDomain;
  types: Record<string, readonly { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

let signerPromise: Promise<any> | null = null;

async function signer() {
  if (signerPromise) return signerPromise;
  signerPromise = (async () => {
    const url = process.env.LEDGER_SPECULOS_URL;
    const builder = new DeviceManagementKitBuilder();
    if (url) {
      builder.addTransport(speculosTransportFactory(url, false, DeviceModelId.NANO_X));
    }
    const dmk = builder.build();
    const device = await firstValueFrom(dmk.startDiscovering({}));
    const sessionId = await dmk.connect({ device });
    return new SignerEthBuilder({ dmk, sessionId, originToken: "attenuate" }).build();
  })();
  return signerPromise;
}

function drive<T>(observable: any, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    observable.subscribe({
      next: (s: any) => {
        if (s.status === DeviceActionStatus.Completed) resolve(s.output);
        if (s.status === DeviceActionStatus.Error) {
          reject(new Error(`${label}: ${JSON.stringify(s.error)}`));
        }
      },
      error: reject,
    });
  });
}

export async function getAddress(path = DEFAULT_PATH): Promise<Address> {
  const s = await signer();
  const out = await drive<{ address: Address }>(s.getAddress(path).observable, "getAddress");
  return out.address;
}

export async function signTypedData(req: TypedDataRequest, path = DEFAULT_PATH): Promise<Hex> {
  const s = await signer();
  const out = await drive<{ r: string; s: string; v: number }>(
    s.signTypedData(path, req).observable,
    "signTypedData",
  );
  const v = out.v.toString(16).padStart(2, "0");
  return `0x${out.r.replace(/^0x/, "")}${out.s.replace(/^0x/, "")}${v}` as Hex;
}
