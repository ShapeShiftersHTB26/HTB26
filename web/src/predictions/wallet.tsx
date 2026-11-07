// One "signer" abstraction over a browser wallet (wallet-adapter) or a local burner keypair.
// The burner makes the demo work on a local validator / devnet without any wallet extension:
// fund it from the faucet (mUSDC + a little SOL) and trade.
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { Keypair, PublicKey, SendTransactionError, Transaction } from '@solana/web3.js';
import { createContext, ReactNode, useCallback, useContext, useMemo, useState } from 'react';

const BURNER_KEY = 'pm-burner-secret';
const USE_BURNER_KEY = 'pm-use-burner';

interface SignerCtx {
  publicKey: PublicKey | null;
  kind: 'wallet' | 'burner' | null;
  send: (tx: Transaction) => Promise<string>;
  useBurner: (on: boolean) => void;
}

const Ctx = createContext<SignerCtx | null>(null);

function loadBurner(): Keypair {
  try {
    const raw = localStorage.getItem(BURNER_KEY);
    if (raw) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  } catch {
    /* fall through to a fresh key */
  }
  const kp = Keypair.generate();
  try {
    localStorage.setItem(BURNER_KEY, JSON.stringify(Array.from(kp.secretKey)));
  } catch {
    /* storage unavailable: burner lives for this session only */
  }
  return kp;
}

function readableError(e: unknown): Error {
  if (e instanceof SendTransactionError && e.logs?.length) {
    const tail = e.logs.filter((l) => l.includes('Error') || l.includes('failed')).slice(-2);
    return new Error(tail.join(' | ') || e.message);
  }
  return e instanceof Error ? e : new Error(String(e));
}

export function SignerProvider({ children }: { children: ReactNode }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [burner, setBurner] = useState<Keypair | null>(() => {
    try {
      return localStorage.getItem(USE_BURNER_KEY) === '1' ? loadBurner() : null;
    } catch {
      return null;
    }
  });

  const useBurner = useCallback((on: boolean) => {
    try {
      localStorage.setItem(USE_BURNER_KEY, on ? '1' : '0');
    } catch {
      /* ignore */
    }
    setBurner(on ? loadBurner() : null);
  }, []);

  const send = useCallback(
    async (tx: Transaction): Promise<string> => {
      try {
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        tx.recentBlockhash = blockhash;
        let sig: string;
        if (burner) {
          tx.feePayer = burner.publicKey;
          tx.sign(burner);
          sig = await connection.sendRawTransaction(tx.serialize());
        } else if (wallet.publicKey) {
          tx.feePayer = wallet.publicKey;
          sig = await wallet.sendTransaction(tx, connection);
        } else {
          throw new Error('connect a wallet or use the burner wallet');
        }
        const res = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
        if (res.value.err) throw new Error(`transaction failed: ${JSON.stringify(res.value.err)}`);
        return sig;
      } catch (e) {
        throw readableError(e);
      }
    },
    [connection, wallet, burner],
  );

  const value = useMemo<SignerCtx>(
    () => ({
      publicKey: burner ? burner.publicKey : wallet.publicKey,
      kind: burner ? 'burner' : wallet.publicKey ? 'wallet' : null,
      send,
      useBurner,
    }),
    [burner, wallet.publicKey, send, useBurner],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSigner(): SignerCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useSigner outside SignerProvider');
  return c;
}
