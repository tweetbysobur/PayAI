"use client";

import { useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { QRCodeCanvas } from "qrcode.react";
import { X, Copy, Check, Download, Share2, Wallet as WalletIcon, ChevronDown } from "lucide-react";
import { parseEther, parseUnits } from "viem";
import { Badge } from "@/components/ui";
import { MonadMark } from "@/components/MonadMark";
import { TokenLogo } from "@/components/TokenLogo";
import { useModalA11y } from "@/lib/hooks/useModalA11y";
import { useWalletService as useWallet } from "@/lib/wallet-service/WalletServiceContext";
import { useIdentity } from "@/lib/hooks/useIdentity";
import { useToast } from "@/components/Toast";
import { MONAD_CHAIN_ID, MONAD_CHAIN_NAME, MONAD_USDC, MONAD_USDC_DECIMALS } from "@/lib/monad/public";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * Receive screen: the connected wallet's own address as a scannable QR plus
 * copy/share/download. Optionally encodes a specific amount as an EIP-681
 * payment request so the sender's wallet pre-fills the transfer. Never shows
 * anyone else's address — strictly the connected wallet.
 */
export function ReceiveModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const wallet = useWallet();
  const identity = useIdentity(wallet.address);
  const { toast } = useToast();
  useModalA11y(open, onClose);
  const [copied, setCopied] = useState(false);
  const [showAmount, setShowAmount] = useState(false);
  const [token, setToken] = useState<"MON" | "USDC">("MON");
  const [amount, setAmount] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);

  const address = wallet.address ?? "";

  // Plain address by default; a valid amount produces an EIP-681 request URI so
  // the scanning wallet pre-fills token + amount. USDC needs its token address.
  const qrValue = useMemo(() => {
    const amt = Number(amount);
    if (!address) return "";
    if (!showAmount || !amount || !(amt > 0)) return address;
    try {
      if (token === "MON") {
        return `ethereum:${address}@${MONAD_CHAIN_ID}?value=${parseEther(amount).toString()}`;
      }
      if (MONAD_USDC) {
        return `ethereum:${MONAD_USDC}@${MONAD_CHAIN_ID}/transfer?address=${address}&uint256=${parseUnits(amount, MONAD_USDC_DECIMALS).toString()}`;
      }
    } catch {
      /* fall through to plain address on a bad amount */
    }
    return address;
  }, [address, showAmount, amount, token]);

  function copy() {
    if (!address) return;
    navigator.clipboard?.writeText(address).then(() => {
      setCopied(true);
      toast("Address copied");
      setTimeout(() => setCopied(false), 1600);
    });
  }

  function download() {
    const canvas = wrapRef.current?.querySelector("canvas");
    if (!canvas) return;
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = `payai-${short(address)}.png`;
    a.click();
    toast("QR code saved");
  }

  async function share() {
    if (!navigator.share) return copy();
    try {
      await navigator.share({ title: "My PayAI address", text: address });
    } catch {
      /* user cancelled */
    }
  }

  // No AnimatePresence — see the note in components/dashboard/TemplatePicker.tsx.
  return (
    <>
      {open && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/85 px-4 sm:backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            role="dialog" aria-modal="true" aria-label="Receive payment"
            initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm overflow-hidden rounded-2xl border border-border bg-panel shadow-2xl"
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/12 text-primary-ink"><WalletIcon size={15} /></span>
                <p className="text-sm font-semibold text-foreground">Receive</p>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone="neutral"><span className="flex items-center gap-1"><MonadMark size={10} /> {MONAD_CHAIN_NAME}</span></Badge>
                <button onClick={onClose} aria-label="Close" className="rounded-md p-1 text-muted-foreground transition hover:bg-input hover:text-foreground"><X size={16} /></button>
              </div>
            </div>

            {!address ? (
              <div className="flex flex-col items-center px-6 py-12 text-center">
                <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-input text-muted-foreground"><WalletIcon size={22} /></span>
                <p className="text-sm font-medium text-foreground">Connect your wallet</p>
                <p className="mt-1 text-xs text-muted-foreground">Connect a wallet to show your address and QR code.</p>
              </div>
            ) : (
              <div className="px-5 py-5">
                {/* QR */}
                <div ref={wrapRef} className="mx-auto w-fit rounded-2xl bg-white p-4 shadow-sm">
                  <QRCodeCanvas
                    value={qrValue}
                    size={196}
                    level="H"
                    marginSize={0}
                    fgColor="#0b0616"
                    bgColor="#ffffff"
                    imageSettings={{ src: "/payai-logo-256.png", height: 40, width: 40, excavate: true }}
                  />
                </div>

                {/* Identity + address */}
                <div className="mt-4 text-center">
                  {identity.domain && <p className="text-sm font-semibold text-primary-ink">{identity.domain}</p>}
                  <button onClick={copy} className="mt-1 inline-flex items-center gap-2 rounded-lg border border-border bg-input/40 px-3 py-2 font-mono text-xs text-foreground transition hover:border-primary/40">
                    {short(address)}
                    {copied ? <Check size={13} className="text-success" /> : <Copy size={13} className="text-muted-foreground" />}
                  </button>
                </div>

                {/* Request a specific amount (optional) */}
                <div className="mt-4 rounded-xl border border-border">
                  <button
                    onClick={() => setShowAmount((s) => !s)}
                    className="flex w-full items-center justify-between px-3.5 py-2.5 text-xs font-medium text-foreground"
                  >
                    Request a specific amount
                    <ChevronDown size={14} className={`text-muted-foreground transition ${showAmount ? "rotate-180" : ""}`} />
                  </button>
                  <AnimatePresence>
                    {showAmount && (
                      <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                        <div className="flex items-center gap-2 border-t border-border p-3">
                          <input
                            value={amount}
                            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                            inputMode="decimal"
                            placeholder="0.00"
                            className="w-full rounded-lg border border-border bg-input px-3 py-2 text-base text-foreground outline-none placeholder:text-muted-foreground/50 focus:border-primary/40"
                          />
                          <div className="flex shrink-0 gap-1 rounded-full border border-border bg-input p-1">
                            {(["MON", "USDC"] as const).map((t) => (
                              <button
                                key={t}
                                onClick={() => setToken(t)}
                                className={`flex items-center gap-1 rounded-full px-2.5 py-1.5 text-xs font-medium transition ${token === t ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
                              >
                                <TokenLogo token={t} size={13} /> {t}
                              </button>
                            ))}
                          </div>
                        </div>
                        {showAmount && Number(amount) > 0 && (
                          <p className="px-3 pb-3 text-[11px] text-muted-foreground">
                            The QR now requests {amount} {token}. A scanning wallet will pre-fill the amount.
                          </p>
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {/* Actions */}
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <button onClick={share} className="flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition hover:opacity-90">
                    <Share2 size={15} /> Share
                  </button>
                  <button onClick={download} className="flex items-center justify-center gap-2 rounded-lg border border-border px-4 py-2.5 text-sm text-foreground transition hover:bg-input">
                    <Download size={15} /> Save QR
                  </button>
                </div>

                <p className="mt-4 text-center text-[11px] leading-relaxed text-muted-foreground">
                  Only send assets on {MONAD_CHAIN_NAME} to this address. Sending from another network may lose the funds.
                </p>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </>
  );
}
