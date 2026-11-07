import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { useEffect, useState } from 'react';
import { api } from './api';
import MarketList from './components/MarketList';
import MarketPage from './components/MarketPage';
import { useBalances } from './hooks';
import { useSigner } from './wallet';

function useHashRoute(): number | null {
  const parse = () => {
    const m = window.location.hash.match(/^#\/market\/(\d+)/);
    return m ? Number(m[1]) : null;
  };
  const [id, setId] = useState<number | null>(parse);
  useEffect(() => {
    const on = () => setId(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return id;
}

function Header() {
  const { publicKey, kind, useBurner } = useSigner();
  const { bal, refresh } = useBalances(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const faucet = async () => {
    if (!publicKey) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.faucet(publicKey.toBase58());
      setMsg(`+${r.musdc} mUSDC`);
      refresh();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <header className="header">
      <a className="brand" href="#/">
        <span className="logo">◐</span> Onchain Prediction Markets
      </a>
      <div className="header-right">
        {publicKey && (
          <span className="balances" title={publicKey.toBase58()}>
            {bal.usdc.toLocaleString(undefined, { maximumFractionDigits: 2 })} mUSDC · {bal.sol.toFixed(3)} SOL
          </span>
        )}
        {publicKey && (
          <button className="btn ghost" onClick={faucet} disabled={busy}>
            {busy ? 'Requesting…' : 'Faucet'}
          </button>
        )}
        {msg && <span className="hint">{msg}</span>}
        <button className="btn ghost" onClick={() => useBurner(kind !== 'burner')}>
          {kind === 'burner' ? 'Leave burner' : 'Burner wallet'}
        </button>
        {kind !== 'burner' && <WalletMultiButton />}
        {kind === 'burner' && publicKey && <span className="pill">burner {publicKey.toBase58().slice(0, 4)}…</span>}
      </div>
    </header>
  );
}

export default function App() {
  const id = useHashRoute();
  return (
    <div className="app">
      <Header />
      <main className="main">{id === null ? <MarketList /> : <MarketPage id={id} />}</main>
    </div>
  );
}
