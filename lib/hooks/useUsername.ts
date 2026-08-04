"use client";

import { useCallback, useEffect, useState } from "react";
import { defaultUsername, formatUsername } from "@/lib/platform/username";

/**
 * A wallet's PayAI username.
 *
 * Resolves optimistically: the address-derived default is available
 * immediately with no network call, and a stored override (if the owner has
 * set one) replaces it when the fetch returns. That means a handle is never
 * blank and never flashes a placeholder — the default IS a real, permanent
 * identity, not a loading state.
 */
export function useUsername(address?: string | null) {
  const [username, setUsername] = useState<string | null>(null);
  const [isDefault, setIsDefault] = useState(true);

  const load = useCallback(() => {
    if (!address) { setUsername(null); return; }
    // Show the derived handle straight away, then reconcile.
    setUsername(defaultUsername(address));
    setIsDefault(true);
    fetch(`/api/username?address=${address}`)
      .then((r) => r.json())
      .then((j) => {
        if (typeof j?.username === "string") {
          setUsername(j.username);
          setIsDefault(!!j.isDefault);
        }
      })
      .catch(() => {
        // Offline or KV down — the derived default is still correct and
        // usable, so there is nothing to report to the user.
      });
  }, [address]);

  useEffect(() => { load(); }, [load]);

  return {
    username,
    isDefault,
    /** Display form, with the @. Empty string when there's no wallet. */
    display: username ? formatUsername(username) : "",
    refresh: load,
  };
}
