"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useConnect, useConnection, useConnectors, useDisconnect } from "wagmi";
import { Wallet, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { shortHash } from "@/lib/format";
import { DEV_ACCOUNT, LOCAL_FORK } from "@/lib/config";

type Ctx = { open: () => void };
const WalletDialogContext = createContext<Ctx | null>(null);

export function useWalletDialog(): Ctx {
  const ctx = useContext(WalletDialogContext);
  if (!ctx) throw new Error("useWalletDialog outside WalletDialogProvider");
  return ctx;
}

export function WalletDialogProvider({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const connectors = useConnectors();
  const { connect, isPending, error, reset } = useConnect();
  const [chosen, setChosen] = useState<string | null>(null);
  const { isConnected } = useConnection();

  const close = useCallback(() => ref.current?.close(), []);
  const open = useCallback(() => {
    reset();
    setChosen(null);
    ref.current?.showModal();
  }, [reset]);
  const [hasEthereum, setHasEthereum] = useState(false);
  useEffect(() => setHasEthereum("ethereum" in window), []);
  // Named wallets from EIP-6963 replace the generic "Injected" entry; an installed Coinbase extension replaces the SDK entry.
  const named = connectors.filter((c) => c.type === "injected" && c.id !== "injected");
  const shown = connectors.filter((c) => {
    if (c.id === "injected") return named.length === 0 && hasEthereum;
    if (c.id === "coinbaseWalletSDK") return !named.some((n) => n.id === "com.coinbase.wallet");
    return true;
  });

  useEffect(() => {
    if (isConnected) ref.current?.close();
  }, [isConnected]);

  return (
    <WalletDialogContext.Provider value={{ open }}>
      {children}
      <dialog
        ref={ref}
        aria-labelledby="wallet-dialog-title"
        className="m-auto w-[min(92vw,380px)] rounded-card border border-rule-2 bg-panel p-0 text-ink-2 backdrop:bg-paper/80"
        onClick={(e) => { if (e.target === ref.current) close(); }}
      >
        <div className="flex items-center justify-between border-b border-rule px-5 py-4">
          <h2 id="wallet-dialog-title" className="text-[24px]">Choose a wallet</h2>
          <Button variant="ghost" size="sm" onClick={close} aria-label="Close"><X className="size-4" aria-hidden /></Button>
        </div>
        <div className="grid grid-cols-1 gap-2 p-5">
          {LOCAL_FORK && shown.length === 0 ? (
            <p className="text-[14px]">This page runs on a local fork and has no test account. Start it with scripts/dev-fork.sh, which sets NEXT_PUBLIC_DEV_ACCOUNT.</p>
          ) : (
            shown.map((c) => (
              <Button
                key={c.uid}
                variant="secondary"
                className="justify-start"
                loading={isPending && chosen === c.uid}
                onClick={() => { setChosen(c.uid); connect({ connector: c }); }}
              >
                {c.icon ? <img src={c.icon} alt="" className="size-5 rounded-sm" /> : c.id === "coinbaseWalletSDK" ? <img src="/tokens/coinbase-wallet.svg" alt="" className="size-5 rounded-sm" /> : <Wallet className="size-4" aria-hidden />}
                {c.type === "mock" && DEV_ACCOUNT ? `Fork test account ${shortHash(DEV_ACCOUNT)}` : c.id === "injected" ? "Browser wallet" : c.name}
              </Button>
            ))
          )}
          {!LOCAL_FORK && named.length === 0 ? <p className="text-[13px] text-muted">No wallet extension was found in this browser. Coinbase Wallet works from a phone or a passkey, or install any wallet that supports Base and reload.</p> : null}
          {error ? <p role="alert" className="text-[13px] text-danger-ink">{error.message.split("\n")[0]}</p> : null}
        </div>
      </dialog>
    </WalletDialogContext.Provider>
  );
}

export function WalletButton({ className }: { className?: string }) {
  const { open } = useWalletDialog();
  const { address, isConnected } = useConnection();
  const { disconnect } = useDisconnect();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <Button variant="secondary" size="sm" className={className} disabled>Connect wallet</Button>;
  if (isConnected && address) {
    return (
      <div className="flex items-center gap-2">
        <span className="num hidden rounded-control bg-panel px-2.5 py-1.5 text-[13px] text-ink sm:inline" title={address}>{shortHash(address)}</span>
        <Button variant="ghost" size="sm" onClick={() => disconnect()}>Disconnect</Button>
      </div>
    );
  }
  return <Button variant="secondary" size="sm" className={className} onClick={open}>Connect wallet</Button>;
}
