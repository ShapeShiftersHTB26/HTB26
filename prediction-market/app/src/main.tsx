import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import '@solana/wallet-adapter-react-ui/styles.css';
import { StrictMode, createContext, useContext, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, PublicConfig } from './api';
import App from './App';
import { Addrs, addrsFromConfig } from './solana';
import './styles.css';
import { SignerProvider } from './wallet';

interface AppConfig {
  cfg: PublicConfig;
  addrs: Addrs;
}
const ConfigCtx = createContext<AppConfig | null>(null);
export const useAppConfig = () => useContext(ConfigCtx)!;

function Root() {
  const [cfg, setCfg] = useState<PublicConfig | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.config().then(setCfg).catch((e) => setErr(String(e.message ?? e)));
  }, []);

  if (err) return <div className="boot">Backend unreachable ({err}). Is <code>cargo run</code> running in backend/?</div>;
  if (!cfg) return <div className="boot">Loading…</div>;

  return (
    <ConfigCtx.Provider value={{ cfg, addrs: addrsFromConfig(cfg) }}>
      <ConnectionProvider endpoint={cfg.rpc_url} config={{ commitment: 'confirmed' }}>
        {/* Wallet Standard wallets (Phantom, Solflare, Backpack, …) are detected automatically. */}
        <WalletProvider wallets={[]} autoConnect>
          <WalletModalProvider>
            <SignerProvider>
              <App />
            </SignerProvider>
          </WalletModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    </ConfigCtx.Provider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
