import type { Address, Hex, WalletClient } from "viem";
import { domain, ROOT_MANDATE_TYPES, type RootMandate } from "../../broker/mandate.js";

export type MandateKind = "device" | "software";

export interface MandateSigner {
  address: Address;
  kind: MandateKind;
  sign(chainId: number, store: Address, mandate: RootMandate): Promise<Hex>;
}

const SPECULOS_DEFAULT = "http://localhost:5001";

async function speculosUrl(): Promise<string | undefined> {
  if (process.env.LEDGER_SPECULOS_URL) return process.env.LEDGER_SPECULOS_URL;
  try {
    const r = await fetch(`${SPECULOS_DEFAULT}/events`, { signal: AbortSignal.timeout(400) });
    if (r.ok) return SPECULOS_DEFAULT;
  } catch {
    // no emulator
  }
  return undefined;
}

export async function resolveMandateSigner(wallet: WalletClient): Promise<MandateSigner> {
  const url = await speculosUrl();
  if (url) {
    process.env.LEDGER_SPECULOS_URL = url;
    console.log(`  device reachable at ${url}`);
    console.log("  if signing hangs, run `npm run speculos:approve` in another terminal");
    const { getAddress } = await import("../../broker/device.js");
    const { signRootMandate } = await import("../../broker/mandate.js");
    const address = await getAddress();
    return {
      address,
      kind: "device",
      sign: (chainId, store, mandate) => signRootMandate(chainId, store, mandate),
    };
  }

  const address = wallet.account!.address;
  return {
    address,
    kind: "software",
    async sign(chainId, store, mandate) {
      return wallet.signTypedData({
        account: wallet.account!,
        domain: domain(chainId, store),
        types: ROOT_MANDATE_TYPES,
        primaryType: "RootMandate",
        message: mandate,
      });
    },
  };
}
