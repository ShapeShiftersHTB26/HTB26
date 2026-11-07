import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MarketInfo } from './api';
import { useAppConfig } from './main';
import { L2, loadL2, mid, tokenBalance } from './solana';
import { useSigner } from './wallet';

/** Run `fn` now and every `ms`; returns a manual refresh. */
export function usePoll(fn: () => Promise<void> | void, ms: number, deps: unknown[]) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    let alive = true;
    const run = () => alive && Promise.resolve(saved.current()).catch(() => {});
    run();
    const t = setInterval(run, ms);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return useCallback(() => Promise.resolve(saved.current()).catch(() => {}), []);
}

export interface Books {
  yes: L2 | null;
  no: L2 | null;
  /** Implied YES probability: average of YES mid and 1 − NO mid. */
  prob: number | null;
}

export interface ProbPoint {
  t: number;
  p: number;
}

export function useBooks(m: MarketInfo | null) {
  const { connection } = useConnection();
  const { addrs } = useAppConfig();
  const [books, setBooks] = useState<Books>({ yes: null, no: null, prob: null });
  const [history, setHistory] = useState<ProbPoint[]>([]);

  const refresh = usePoll(
    async () => {
      if (!m?.yes_book || !m?.no_book) return;
      const [yes, no] = await Promise.all([
        loadL2(connection, addrs.openbookId, new PublicKey(m.yes_book.ob_market)),
        loadL2(connection, addrs.openbookId, new PublicKey(m.no_book.ob_market)),
      ]);
      const ym = mid(yes);
      const nm = mid(no);
      const parts = [ym, nm === null ? null : 1 - nm].filter((x): x is number => x !== null);
      const prob = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
      setBooks({ yes, no, prob });
      if (prob !== null) setHistory((h) => [...h.slice(-199), { t: Date.now(), p: prob }]);
    },
    3000,
    [m?.id, m?.yes_book?.ob_market],
  );
  return { books, history, refresh };
}

export interface Balances {
  usdc: number;
  yes: number;
  no: number;
  sol: number;
}

export function useBalances(m: MarketInfo | null) {
  const { connection } = useConnection();
  const { addrs } = useAppConfig();
  const { publicKey } = useSigner();
  const [bal, setBal] = useState<Balances>({ usdc: 0, yes: 0, no: 0, sol: 0 });

  const refresh = usePoll(
    async () => {
      if (!publicKey) return setBal({ usdc: 0, yes: 0, no: 0, sol: 0 });
      const [usdc, yes, no, lamports] = await Promise.all([
        tokenBalance(connection, publicKey, addrs.musdc),
        m?.yes_mint ? tokenBalance(connection, publicKey, new PublicKey(m.yes_mint)) : Promise.resolve(0),
        m?.no_mint ? tokenBalance(connection, publicKey, new PublicKey(m.no_mint)) : Promise.resolve(0),
        connection.getBalance(publicKey, 'confirmed'),
      ]);
      setBal({ usdc, yes, no, sol: lamports / 1e9 });
    },
    4000,
    [publicKey?.toBase58(), m?.id],
  );
  return { bal, refresh };
}
