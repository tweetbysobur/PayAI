"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Search, Star, ChevronDown, ShieldCheck, X, Loader2 } from "lucide-react";
import { TokenLogo } from "@/components/TokenLogo";
import { useTokenBalance } from "@/lib/hooks/useTokenBalance";
import { useTokenPrices, formatUsd } from "@/lib/hooks/useTokenPrices";

export interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string | null;
  verified: boolean;
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const FAVORITES_KEY = "payai_favorite_tokens";
const RECENT_KEY = "payai_recent_tokens";

function readList(key: string): string[] {
  if (typeof window === "undefined") return [];
  try { return JSON.parse(localStorage.getItem(key) ?? "[]"); } catch { return []; }
}
function writeList(key: string, list: string[]) {
  localStorage.setItem(key, JSON.stringify(list.slice(0, 8)));
}

/** A professional token picker: verified list, search by name/symbol, paste
 *  any contract address, recently used + favorites, wallet balance, and a
 *  Verified badge — the same component every template and Bulk Payments
 *  uses, so "any fungible token on Monad" is one real implementation, not
 *  N copies. */
export function TokenSelector({ value, onChange, walletAddress, disabled }: {
  value: TokenInfo | null;
  onChange: (token: TokenInfo) => void;
  walletAddress?: string | null;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [verified, setVerified] = useState<TokenInfo[]>([]);
  const [pasted, setPasted] = useState<TokenInfo | null>(null);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setFavorites(readList(FAVORITES_KEY));
    setRecent(readList(RECENT_KEY));
  }, []);

  useEffect(() => {
    if (!open) return;
    fetch("/api/tokens").then((r) => r.json()).then((j) => { if (j.success) setVerified(j.tokens); }).catch(() => {});
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onOutside = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  // If the query looks like a contract address, resolve it live — this is
  // what makes an arbitrary, non-curated Monad token usable, not just the
  // verified shortlist.
  useEffect(() => {
    setPasted(null); setResolveError(null);
    if (!ADDR_RE.test(query.trim())) return;
    const handle = setTimeout(() => {
      setResolving(true);
      fetch(`/api/tokens?address=${encodeURIComponent(query.trim())}`)
        .then((r) => r.json())
        .then((j) => { if (j.success) setPasted(j.token); else setResolveError(j.error ?? "Could not resolve this token."); })
        .catch(() => setResolveError("Could not resolve this token."))
        .finally(() => setResolving(false));
    }, 400);
    return () => clearTimeout(handle);
  }, [query]);

  const byAddress = useMemo(() => {
    const map = new Map<string, TokenInfo>();
    for (const t of verified) map.set(t.address.toLowerCase(), t);
    return map;
  }, [verified]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || ADDR_RE.test(query.trim())) return verified;
    return verified.filter((t) => t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q));
  }, [verified, query]);

  const favoriteTokens = favorites.map((a) => byAddress.get(a.toLowerCase())).filter((t): t is TokenInfo => !!t);
  const recentTokens = recent.map((a) => byAddress.get(a.toLowerCase())).filter((t): t is TokenInfo => !!t);

  function select(token: TokenInfo) {
    onChange(token);
    const next = [token.address, ...recent.filter((a) => a.toLowerCase() !== token.address.toLowerCase())];
    setRecent(next); writeList(RECENT_KEY, next);
    setOpen(false); setQuery("");
  }

  function toggleFavorite(address: string, e: React.MouseEvent) {
    e.stopPropagation();
    const has = favorites.some((a) => a.toLowerCase() === address.toLowerCase());
    const next = has ? favorites.filter((a) => a.toLowerCase() !== address.toLowerCase()) : [address, ...favorites];
    setFavorites(next); writeList(FAVORITES_KEY, next);
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 rounded-lg border border-border bg-input px-3.5 py-2.5 text-sm text-foreground transition hover:border-primary/40 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {value ? (
          <>
            <TokenLogo token={value.symbol} logoURI={value.logoURI} size={20} />
            <span className="font-medium">{value.symbol}</span>
            <span className="truncate text-xs text-muted-foreground">{value.name}</span>
            {value.verified && <ShieldCheck size={13} className="ml-auto shrink-0 text-primary-ink" />}
          </>
        ) : (
          <span className="text-muted-foreground">Select a token</span>
        )}
        <ChevronDown size={14} className={`ml-auto shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""} ${value?.verified ? "" : ""}`} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
            className="absolute left-0 top-full z-30 mt-2 w-full min-w-[22rem] overflow-hidden rounded-xl border border-border bg-panel shadow-2xl"
          >
            <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
              <Search size={14} className="shrink-0 text-muted-foreground" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name, symbol, or paste a token address"
                className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              />
              {resolving && <Loader2 size={13} className="shrink-0 animate-spin text-muted-foreground" />}
              {query && <button onClick={() => setQuery("")} className="shrink-0 text-muted-foreground hover:text-foreground"><X size={13} /></button>}
            </div>

            <div className="max-h-80 overflow-y-auto p-1.5">
              {ADDR_RE.test(query.trim()) ? (
                pasted ? (
                  <TokenRow token={pasted} walletAddress={walletAddress} onSelect={select} isFavorite={false} onToggleFavorite={toggleFavorite} />
                ) : resolveError ? (
                  <p className="px-3 py-4 text-center text-xs text-danger">{resolveError}</p>
                ) : (
                  <p className="px-3 py-4 text-center text-xs text-muted-foreground">Resolving token…</p>
                )
              ) : (
                <>
                  {!query && favoriteTokens.length > 0 && (
                    <Section title="Favorites">
                      {favoriteTokens.map((t) => (
                        <TokenRow key={t.address} token={t} walletAddress={walletAddress} onSelect={select} isFavorite onToggleFavorite={toggleFavorite} />
                      ))}
                    </Section>
                  )}
                  {!query && recentTokens.length > 0 && (
                    <Section title="Recently used">
                      {recentTokens.map((t) => (
                        <TokenRow key={t.address} token={t} walletAddress={walletAddress} onSelect={select} isFavorite={favorites.some((a) => a.toLowerCase() === t.address.toLowerCase())} onToggleFavorite={toggleFavorite} />
                      ))}
                    </Section>
                  )}
                  <Section title="Verified tokens">
                    {filtered.length ? filtered.map((t) => (
                      <TokenRow key={t.address} token={t} walletAddress={walletAddress} onSelect={select} isFavorite={favorites.some((a) => a.toLowerCase() === t.address.toLowerCase())} onToggleFavorite={toggleFavorite} />
                    )) : <p className="px-3 py-4 text-center text-xs text-muted-foreground">No match — paste a token&apos;s contract address to use it directly.</p>}
                  </Section>
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-1">
      <p className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{title}</p>
      {children}
    </div>
  );
}

function TokenRow({ token, walletAddress, onSelect, isFavorite, onToggleFavorite }: {
  token: TokenInfo; walletAddress?: string | null; onSelect: (t: TokenInfo) => void;
  isFavorite: boolean; onToggleFavorite: (address: string, e: React.MouseEvent) => void;
}) {
  const { balance, loading } = useTokenBalance(token.address, token.decimals, walletAddress ?? null);
  // One shared price lookup across the whole list (module-level cache), so a
  // dropdown of seven tokens doesn't fire seven independent requests.
  const { usdValue } = useTokenPrices([{ address: token.address, decimals: token.decimals }]);
  const usd = balance != null ? formatUsd(usdValue(token.address, Number(balance))) : null;
  return (
    <button
      type="button"
      onClick={() => onSelect(token)}
      className="group flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition hover:bg-input/60"
    >
      <TokenLogo token={token.symbol} logoURI={token.logoURI} size={26} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-foreground">{token.symbol}</span>
          {token.verified && <ShieldCheck size={12} className="shrink-0 text-primary-ink" aria-label="Verified" />}
        </div>
        <p className="truncate text-xs text-muted-foreground">{token.name}</p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-xs font-medium text-foreground">
          {walletAddress ? (loading ? "…" : balance != null ? Number(balance).toLocaleString(undefined, { maximumFractionDigits: 4 }) : "—") : "—"}
        </p>
        {/* Only rendered when there's a real price — an unpriceable token shows
            nothing rather than "$0.00", which would read as worthless. */}
        {usd && <p className="text-[10px] tabular-nums text-muted-foreground">≈ {usd}</p>}
      </div>
      <span onClick={(e) => onToggleFavorite(token.address, e)} className="shrink-0 text-muted-foreground transition hover:text-warning">
        <Star size={14} fill={isFavorite ? "currentColor" : "none"} className={isFavorite ? "text-warning" : ""} />
      </span>
    </button>
  );
}
