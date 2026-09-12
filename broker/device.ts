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
let session: { dmk: any; sessionId: string } | null = null;

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
    session = { dmk, sessionId };
    return new SignerEthBuilder({ dmk, sessionId, originToken: "attenuate" }).build();
  })();
  return signerPromise;
}

async function release() {
  const s = session;
  session = null;
  signerPromise = null;
  if (!s) return;
  try {
    await s.dmk.disconnect({ sessionId: s.sessionId });
  } catch {
    // Already gone; the point is only that the next call opens a fresh session.
  }
  try {
    s.dmk.close?.();
  } catch {}
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
  try {
    const out = await drive<{ address: Address }>(s.getAddress(path).observable, "getAddress");
    return out.address;
  } finally {
    await release();
  }
}

async function signOnce(req: TypedDataRequest, path: string) {
  const s = await signer();
  try {
    return await drive<{ r: string; s: string; v: number }>(
      s.signTypedData(path, req).observable,
      "signTypedData",
    );
  } finally {
    // The device answers a second request on the same session with 0x6980 instead of
    // prompting, so the session is torn down after every signature.
    await release();
  }
}

export async function signTypedData(req: TypedDataRequest, path = DEFAULT_PATH): Promise<Hex> {
  const out = await signOnce(req, path);
  const v = out.v.toString(16).padStart(2, "0");
  return `0x${out.r.replace(/^0x/, "")}${out.s.replace(/^0x/, "")}${v}` as Hex;
}
