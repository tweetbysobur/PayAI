"use client";

import { useCallback, useEffect, useState } from "react";
import { formatUsername, shortAddress } from "@/lib/platform/username";

/**
 * A wallet's PayAI username, or null when its owner hasn't chosen one.
 *
 * There is deliberately no generated fallback identity: `display` shows the
 * shortened address until a real handle exists, which is honest about the
 * fact that the user hasn't named themselves yet. `hasUsername` lets callers
 * invite them to pick one.
 */
export function useUsername(address?: string | null) {
  const [username, setUsername] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    if (!address) { setUsername(null); return; }
    setLoading(true);
    fetch(`/api/username?address=${address}`)
      .then((r) => r.json())
      .then((j) => setUsername(typeof j?.username === "string" ? j.username : null))
      .catch(() => setUsername(null))
      .finally(() => setLoading(false));
  }, [address]);

  useEffect(() => { load(); }, [load]);

  return {
    username,
    hasUsername: !!username,
    loading,
    /** What to show for this wallet: its handle, or its short address. */
    display: username ? formatUsername(username) : address ? shortAddress(address) : "",
    refresh: load,
  };
}
