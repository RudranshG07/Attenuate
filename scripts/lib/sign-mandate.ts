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

/**
 * Speculos shows the same confirmation screens a real Nano does, and nobody is there
 * to press them during a deploy. An emulator left unattended is why a deploy appears
 * to hang and then writes an empty deployment, so we drive the buttons ourselves for
 * the duration and stop when the signature lands. A real device is never touched by
 * this: it only runs when the emulator is the thing we found.
 */
async function autoApprove(url: string): Promise<() => void> {
  if (process.env.SPECULOS_NO_AUTO_APPROVE === "1") return () => {};
  const { driveApprovals } = await import("../speculos-approve.js");
  return driveApprovals(url);
}

export async function resolveMandateSigner(wallet: WalletClient): Promise<MandateSigner> {
  const url = await speculosUrl();
  if (url) {
    process.env.LEDGER_SPECULOS_URL = url;
    console.log(`  device reachable at ${url}, answering its prompts automatically`);
    const { getAddress } = await import("../../broker/device.js");
    const { signRootMandate } = await import("../../broker/mandate.js");
    const stop = await autoApprove(url);
    try {
      const address = await getAddress();
      return {
        address,
        kind: "device",
        sign: async (chainId, store, mandate) => {
          try {
            return await signRootMandate(chainId, store, mandate);
          } finally {
            stop();
          }
        },
      };
    } catch (e) {
      stop();
      throw e;
    }
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
