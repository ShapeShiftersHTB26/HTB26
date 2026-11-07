import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey, Transaction } from '@solana/web3.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BotTrade, MarketInfo, pmApi } from './api';
import { useAppConfig } from './context';
import { L2, loadL2, mid, tokenBalance } from './solana';
import { useToast } from './ui';
import { explorer, fmt } from './util';
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

/** Market-quality numbers for the insights view: average spread of the two books and the $ resting on them. */
export function bookStats(b: Books): { spread: number | null; liquidity: number } {
  const books = [b.yes, b.no].filter((x): x is L2 => x !== null);
  const spreads = books.filter((l) => l.asks[0] && l.bids[0]).map((l) => l.asks[0].price - l.bids[0].price);
  return {
    spread: spreads.length ? spreads.reduce((a, s) => a + s, 0) / spreads.length : null,
    liquidity: books.reduce((sum, l) => sum + [...l.bids, ...l.asks].reduce((t, lv) => t + lv.size * lv.price, 0), 0),
  };
}

/** Recent orders on a market (the demo bots' flow), polled. */
export function useTrades(id: number, ms = 8000): BotTrade[] | null {
  const [trades, setTrades] = useState<BotTrade[] | null>(null);
  useEffect(() => setTrades(null), [id]);
  usePoll(async () => setTrades(await pmApi.trades(id)), ms, [id]);
  return trades;
}

export function impliedProb(yes: L2 | null, no: L2 | null): number | null {
  const ym = yes ? mid(yes) : null;
  const nm = no ? mid(no) : null;
  const parts = [ym, nm === null ? null : 1 - nm].filter((x): x is number => x !== null);
  return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
}

// Module-level caches survive navigation inside the tab: going back and forth shows the last known state at once
// (no empty flashes) and the price chart keeps the history sampled so far.
const EMPTY_BOOKS: Books = { yes: null, no: null, prob: null };
const booksCache = new Map<number, Books>();
const historyCache = new Map<number, ProbPoint[]>();
const marketCache = new Map<number, MarketInfo>();
let marketsCache: MarketInfo[] | null = null;
const quoteCache = new Map<number, Quote>();

export function useBooks(m: MarketInfo | null) {
  const { connection } = useConnection();
  const { addrs } = useAppConfig();
  const [books, setBooks] = useState<Books>(() => (m && booksCache.get(m.id)) || EMPTY_BOOKS);
  const [history, setHistory] = useState<ProbPoint[]>(() => (m && historyCache.get(m.id)) || []);

  useEffect(() => {
    setBooks((m && booksCache.get(m.id)) || EMPTY_BOOKS);
    setHistory((m && historyCache.get(m.id)) || []);
  }, [m?.id]);

  const refresh = usePoll(
    async () => {
      if (!m?.yes_book || !m?.no_book) return;
      const [yes, no] = await Promise.all([
        loadL2(connection, addrs.openbookId, new PublicKey(m.yes_book.ob_market)),
        loadL2(connection, addrs.openbookId, new PublicKey(m.no_book.ob_market)),
      ]);
      const next = { yes, no, prob: impliedProb(yes, no) };
      booksCache.set(m.id, next);
      setBooks(next);
      if (next.prob !== null) {
        const h = [...(historyCache.get(m.id) ?? []).slice(-299), { t: Date.now(), p: next.prob }];
        historyCache.set(m.id, h);
        setHistory(h);
      }
    },
    3000,
    [m?.id, m?.yes_book?.ob_market],
  );
  return { books, history, refresh };
}

/** One market, polled; starts from the cached copy when there is one. */
export function useMarket(id: number) {
  const [market, setMarket] = useState<MarketInfo | null>(() => marketCache.get(id) ?? null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setMarket(marketCache.get(id) ?? null), [id]);
  const refresh = usePoll(
    async () => {
      try {
        const m = await pmApi.market(id);
        marketCache.set(id, m);
        setMarket(m);
        setErr(null);
      } catch (e) {
        setErr((e as Error).message);
      }
    },
    5000,
    [id],
  );
  return { market, err, refresh };
}

/** Best asks (what a buyer pays) and the implied probability, for the market cards. */
export interface Quote {
  prob: number | null;
  yes: number | null;
  no: number | null;
}

export function useMarkets() {
  const { connection } = useConnection();
  const { addrs } = useAppConfig();
  const [markets, setMarkets] = useState<MarketInfo[] | null>(marketsCache);
  const [quotes, setQuotes] = useState<Record<number, Quote>>(() => Object.fromEntries(quoteCache));
  const [err, setErr] = useState<string | null>(null);

  const refresh = usePoll(
    async () => {
      try {
        const ms = await pmApi.markets();
        marketsCache = ms;
        ms.forEach((m) => marketCache.set(m.id, m));
        setMarkets(ms);
        setErr(null);
        await Promise.all(
          ms
            .filter((m) => m.status === 'active' && m.yes_book && m.no_book)
            .map(async (m) => {
              try {
                const [yes, no] = await Promise.all([
                  loadL2(connection, addrs.openbookId, new PublicKey(m.yes_book!.ob_market), 1),
                  loadL2(connection, addrs.openbookId, new PublicKey(m.no_book!.ob_market), 1),
                ]);
                quoteCache.set(m.id, { prob: impliedProb(yes, no), yes: yes.asks[0]?.price ?? null, no: no.asks[0]?.price ?? null });
              } catch {
                /* keep the last quote */
              }
            }),
        );
        setQuotes(Object.fromEntries(quoteCache));
      } catch (e) {
        setErr((e as Error).message);
      }
    },
    5000,
    [],
  );
  return { markets, quotes, err, refresh };
}

export interface Balances {
  usdc: number;
  yes: number;
  no: number;
  sol: number;
}

const BALANCES_EVENT = 'pm:balances';
/** Ask every balance hook to refresh now (after a trade, faucet claim, …) instead of at its next poll. */
export const bumpBalances = () => window.dispatchEvent(new Event(BALANCES_EVENT));

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
  useEffect(() => {
    const on = () => void refresh();
    window.addEventListener(BALANCES_EVENT, on);
    return () => window.removeEventListener(BALANCES_EVENT, on);
  }, [refresh]);
  return { bal, refresh };
}

/** Sign + send a transaction with toasts for the outcome; refreshes balances on success. */
export function useTx() {
  const { send } = useSigner();
  const toast = useToast();
  const { cfg } = useAppConfig();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (tx: Transaction, title: string, detail?: string): Promise<boolean> => {
      setBusy(true);
      try {
        const sig = await send(tx);
        toast({ kind: 'ok', title, detail, href: explorer('tx', sig, cfg.rpc_url) });
        bumpBalances();
        return true;
      } catch (e) {
        toast({ kind: 'err', title: 'Transaction failed', detail: (e as Error).message });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [send, toast, cfg.rpc_url],
  );
  return { run, busy };
}

/** Demo faucet: mUSDC (plus a little SOL for fees) for the connected wallet. */
export function useFaucet() {
  const { publicKey } = useSigner();
  const toast = useToast();
  const { cfg } = useAppConfig();
  const [busy, setBusy] = useState(false);
  const claim = useCallback(async () => {
    if (!publicKey) return;
    setBusy(true);
    try {
      const r = await pmApi.faucet(publicKey.toBase58());
      toast({ kind: 'ok', title: `+${fmt(r.musdc)} mUSDC added`, detail: 'Demo dollars to trade with', href: explorer('tx', r.tx, cfg.rpc_url) });
      bumpBalances();
    } catch (e) {
      toast({ kind: 'err', title: "Couldn't get funds", detail: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }, [publicKey, toast, cfg.rpc_url]);
  return { claim, busy };
}
