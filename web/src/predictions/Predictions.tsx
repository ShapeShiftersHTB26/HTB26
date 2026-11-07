// Predictions tab: on-chain YES/NO prediction markets (prediction-market/ backend + OpenBook v2).
// Loaded lazily by App so the Solana libraries don't weigh on the other tabs.
import { ConnectionProvider, useWallet, WalletProvider } from "@solana/wallet-adapter-react";
import { useWalletModal, WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";
import { ReactNode, useEffect, useState } from "react";
import { pmApi, PublicConfig } from "./api";
import { ConfigCtx, useAppConfig } from "./context";
import { useBalances, useFaucet } from "./hooks";
import MarketList from "./MarketList";
import MarketPage from "./MarketPage";
import { ModeProvider, ModeSwitch, useMode } from "./mode";
import "./predictions.css";
import { addrsFromConfig } from "./solana";
import { Menu, Skeleton, Spinner, ToastProvider, useToast, useTween } from "./ui";
import { explorer, fmt, short, usd } from "./util";
import { SignerProvider, useSigner } from "./wallet";

export default function Predictions({ nav, marketId }: { nav: ReactNode; marketId: number | null }) {
  const [cfg, setCfg] = useState<PublicConfig | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // The backend may still be bootstrapping (validator, mint, demo markets): keep retrying.
  useEffect(() => {
    let alive = true;
    const load = () =>
      pmApi
        .config()
        .then((c) => alive && setCfg(c))
        .catch((e) => {
          if (!alive) return;
          setErr(String(e.message ?? e));
          setTimeout(load, 3000);
        });
    load();
    return () => {
      alive = false;
    };
  }, []);

  if (!cfg) {
    return (
      <div className="app pm-root">
        <header className="pm-header">
          <strong>Backtrace</strong>
          {nav}
        </header>
        <div className="pm">
          <div className="pm-main">
            {err ? (
              <div className="pm-banner">
                <Spinner /> Waiting for the prediction-market backend ({err}). Is <code>prediction-market-backend</code>{" "}
                running?
              </div>
            ) : (
              <div className="pm-grid">
                {Array.from({ length: 6 }, (_, i) => (
                  <div key={i} className="pm-mcard">
                    <Skeleton h={44} />
                    <Skeleton h={36} />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <ConfigCtx.Provider value={{ cfg, addrs: addrsFromConfig(cfg) }}>
      <ConnectionProvider endpoint={cfg.rpc_url} config={{ commitment: "confirmed" }}>
        {/* Wallet Standard wallets (Phantom, Solflare, Backpack, …) are detected automatically. */}
        <WalletProvider wallets={[]} autoConnect>
          <WalletModalProvider>
            <SignerProvider>
              <ToastProvider>
                <ModeProvider>
                  <Shell nav={nav} marketId={marketId} />
                </ModeProvider>
              </ToastProvider>
            </SignerProvider>
          </WalletModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    </ConfigCtx.Provider>
  );
}

/** Deterministic two-tone avatar from the address. */
function avatar(pk: string): string {
  let h = 0;
  for (const c of pk) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `linear-gradient(135deg, hsl(${h} 75% 62%), hsl(${(h + 70) % 360} 75% 52%))`;
}

function Shell({ nav, marketId }: { nav: ReactNode; marketId: number | null }) {
  const { mode } = useMode();
  return (
    <div className={`app pm-root pm-${mode}`}>
      <header className="pm-header">
        <strong>Backtrace</strong>
        {nav}
        <div className="pm-header-right">
          <ModeSwitch />
          {/* Insights is read-only: wallets only matter when trading. */}
          {mode === "trading" && <WalletControls />}
        </div>
      </header>
      <div className="pm">
        <div className="pm-main" key={mode}>
          {marketId === null ? <MarketList /> : <MarketPage key={marketId} id={marketId} />}
        </div>
      </div>
    </div>
  );
}

function WalletControls() {
  const { publicKey, kind, useBurner } = useSigner();
  const { disconnect } = useWallet();
  const { setVisible } = useWalletModal();
  const { cfg } = useAppConfig();
  const { bal } = useBalances(null);
  const faucet = useFaucet();
  const toast = useToast();
  const cash = useTween(publicKey ? bal.usdc : null);
  const pk = publicKey?.toBase58();

  return pk ? (
    <>
      <div className="pm-cash" title={`${fmt(bal.sol, 4)} SOL for transaction fees`}>
        <span className="pm-cash-label">Cash</span>
        <span className="pm-cash-num">{usd(cash ?? 0)}</span>
      </div>
      <button className="pm-btn pm-btn-soft" onClick={faucet.claim} disabled={faucet.busy}>
        {faucet.busy ? <Spinner /> : "+"} Get funds
      </button>
      <Menu
        button={(open) => (
          <button className={`pm-account${open ? " on" : ""}`} aria-haspopup="menu">
            <span className="pm-avatar" style={{ background: avatar(pk) }} />
            <span className="pm-account-addr">{short(pk)}</span>
            {kind === "burner" && <span className="pm-tag">demo</span>}
            <span className="pm-caret">▾</span>
          </button>
        )}
      >
        {(close) => (
          <>
            <button
              onClick={() => {
                navigator.clipboard?.writeText(pk);
                toast({ kind: "info", title: "Address copied" });
                close();
              }}
            >
              Copy address
            </button>
            <a href={explorer("address", pk, cfg.rpc_url)} target="_blank" rel="noreferrer" onClick={close}>
              View on explorer ↗
            </a>
            <div className="pm-menu-sep" />
            {kind === "burner" ? (
              <button onClick={() => (useBurner(false), close())}>Leave demo wallet</button>
            ) : (
              <>
                <button onClick={() => (useBurner(true), close())}>Switch to demo wallet</button>
                <button onClick={() => (disconnect(), close())}>Disconnect</button>
              </>
            )}
          </>
        )}
      </Menu>
    </>
  ) : (
    <>
      <button className="pm-btn pm-btn-ghost" onClick={() => useBurner(true)} title="A throwaway wallet stored in this browser">
        Try demo wallet
      </button>
      <button className="pm-btn pm-btn-primary" onClick={() => setVisible(true)}>
        Connect wallet
      </button>
    </>
  );
}
