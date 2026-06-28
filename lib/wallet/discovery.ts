"use client";

import { useEffect, useState } from "react";
import type { EthProvider } from "./provider";

/**
 * EIP-6963 multi-wallet discovery. Instead of guessing at the single
 * `window.ethereum` (which is whatever extension won the race to inject — e.g.
 * Rabby clobbering MetaMask), every installed wallet announces itself and the
 * user picks. This is the modern standard browsers + wallets implement.
 */
export interface EIP6963ProviderInfo {
  uuid: string;
  name: string;
  icon: string; // data-URI
  rdns: string;
}
export interface EIP6963ProviderDetail {
  info: EIP6963ProviderInfo;
  provider: EthProvider;
}

export function useDiscoveredWallets(): EIP6963ProviderDetail[] {
  const [wallets, setWallets] = useState<EIP6963ProviderDetail[]>([]);

  useEffect(() => {
    const map = new Map<string, EIP6963ProviderDetail>();
    function onAnnounce(event: Event) {
      const detail = (event as CustomEvent<EIP6963ProviderDetail>).detail;
      if (detail?.info?.rdns && detail.provider) {
        map.set(detail.info.rdns, detail);
        setWallets([...map.values()].sort((a, b) => a.info.name.localeCompare(b.info.name)));
      }
    }
    window.addEventListener("eip6963:announceProvider", onAnnounce as EventListener);
    // Ask any wallets that loaded before us to re-announce.
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    return () => window.removeEventListener("eip6963:announceProvider", onAnnounce as EventListener);
  }, []);

  return wallets;
}
