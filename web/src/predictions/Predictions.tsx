// Predictions tab: on-chain YES/NO prediction markets (prediction-market/ backend + OpenBook v2).
// Loaded lazily by App so the Solana libraries don't weigh on the Main tab.
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider, WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";
import { ReactNode, useEffect, useState } from "react";
import { pmApi, PublicConfig } from "./api";
import { ConfigCtx } from "./context";
import { useBalances } from "./hooks";
import MarketList from "./MarketList";
import MarketPage from "./MarketPage";
import "./predictions.css";
import { addrsFromConfig } from "./solana";
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
      <div className="app">
        <header>
          <strong>Backtrace</strong>
          {nav}
        </header>
        <div className="pm">
          <div className="pm-main">
            <div className="pm-card">
              {err ? (
                <>
                  Prediction-market backend unreachable ({err}). Retrying… Is <code>prediction-market-backend</code> running
                  (<code>docker compose up</code>)?
                </>
              ) : (
                "Loading…"
              )}
            </div>
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
              <div className="app">
                <PmHeader nav={nav} />
                <div className="pm">
                  <div className="pm-main">{marketId === null ? <MarketList /> : <MarketPage id={marketId} />}</div>
                </div>
              </div>
            </SignerProvider>
          </WalletModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    </ConfigCtx.Provider>
  );
}

function PmHeader({ nav }: { nav: ReactNode }) {
  const { publicKey, kind, useBurner } = useSigner();
  const { bal, refresh } = useBalances(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const faucet = async () => {
    if (!publicKey) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await pmApi.faucet(publicKey.toBase58());
      setMsg(`+${r.musdc} mUSDC`);
      refresh();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <header className="pm-header">
      <strong>Backtrace</strong>
      {nav}
      <div className="pm-header-right">
        {publicKey && (
          <span className="pm-balances" title={publicKey.toBase58()}>
            {bal.usdc.toLocaleString(undefined, { maximumFractionDigits: 2 })} mUSDC · {bal.sol.toFixed(3)} SOL
          </span>
        )}
        {publicKey && (
          <button onClick={faucet} disabled={busy}>
            {busy ? "Requesting…" : "Faucet"}
          </button>
        )}
        {msg && <span className="muted small">{msg}</span>}
        <button onClick={() => useBurner(kind !== "burner")}>{kind === "burner" ? "Leave burner" : "Burner wallet"}</button>
        {kind !== "burner" && <WalletMultiButton />}
        {kind === "burner" && publicKey && <span className="pm-pill">burner {publicKey.toBase58().slice(0, 4)}…</span>}
      </div>
    </header>
  );
}
