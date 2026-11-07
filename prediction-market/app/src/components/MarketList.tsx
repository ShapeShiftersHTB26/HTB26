import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { useState } from 'react';
import { api, MarketInfo } from '../api';
import { usePoll } from '../hooks';
import { useAppConfig } from '../main';
import { loadL2, mid } from '../solana';
import { timeLeft } from './util';

export default function MarketList() {
  const { connection } = useConnection();
  const { addrs } = useAppConfig();
  const [markets, setMarkets] = useState<MarketInfo[] | null>(null);
  const [probs, setProbs] = useState<Record<number, number>>({});
  const [err, setErr] = useState<string | null>(null);

  usePoll(
    async () => {
      try {
        const ms = await api.markets();
        setMarkets(ms);
        setErr(null);
        const entries = await Promise.all(
          ms
            .filter((m) => m.status === 'active' && m.yes_book)
            .map(async (m) => {
              const l2 = await loadL2(connection, addrs.openbookId, new PublicKey(m.yes_book!.ob_market), 1).catch(() => null);
              const p = l2 ? mid(l2) : null;
              return [m.id, p ?? m.initial_price_cents / 100] as const;
            }),
        );
        setProbs(Object.fromEntries(entries));
      } catch (e) {
        setErr((e as Error).message);
      }
    },
    5000,
    [],
  );

  if (err) return <div className="card error">{err}</div>;
  if (!markets) return <div className="card">Loading markets…</div>;
  if (!markets.length)
    return (
      <div className="card">
        No markets yet. Create one with <code>POST /markets</code> (see README).
      </div>
    );

  return (
    <div className="grid">
      {markets.map((m) => {
        const p = probs[m.id];
        return (
          <a key={m.id} className="card market-card" href={`#/market/${m.id}`}>
            <div className="row between">
              <span className={`status ${m.status}`}>{m.status === 'resolved' ? `resolved ${m.outcome?.toUpperCase()}` : m.status}</span>
              <span className="muted">{timeLeft(m.resolution_time)}</span>
            </div>
            <h3>{m.question}</h3>
            {m.status === 'active' && (
              <div className="prob-row">
                <div className="prob-bar">
                  <div className="prob-fill" style={{ width: `${((p ?? 0.5) * 100).toFixed(1)}%` }} />
                </div>
                <span className="prob">{p !== undefined ? `${(p * 100).toFixed(0)}%` : '—'}</span>
              </div>
            )}
            {m.status === 'failed' && <div className="muted small">{m.error}</div>}
          </a>
        );
      })}
    </div>
  );
}
