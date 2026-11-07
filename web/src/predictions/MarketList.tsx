import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useState } from "react";
import { MarketInfo, pmApi } from "./api";
import { useAppConfig } from "./context";
import CreateMarket from "./CreateMarket";
import { usePoll } from "./hooks";
import { loadL2, mid } from "./solana";
import { timeLeft } from "./util";

export const marketHref = (id: number) => `#/predictions/market/${id}`;

export default function MarketList() {
  const { connection } = useConnection();
  const { addrs } = useAppConfig();
  const [markets, setMarkets] = useState<MarketInfo[] | null>(null);
  const [probs, setProbs] = useState<Record<number, number>>({});
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = usePoll(
    async () => {
      try {
        const ms = await pmApi.markets();
        setMarkets(ms);
        setErr(null);
        const entries = await Promise.all(
          ms
            .filter((m) => m.status === "active" && m.yes_book)
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

  return (
    <div className="pm-list">
      <div className="pm-row pm-between pm-list-head">
        <h2>Prediction markets</h2>
        {!creating && (
          <button className="pm-btn pm-primary pm-inline" onClick={() => setCreating(true)}>+ Create market</button>
        )}
      </div>
      {creating && (
        <CreateMarket
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            refresh();
            window.location.hash = marketHref(id);
          }}
        />
      )}
      {err && <div className="pm-card error">{err}</div>}
      {!markets && !err && <div className="pm-card">Loading markets…</div>}
      {markets && !markets.length && <div className="pm-card muted">No markets yet. Create the first one.</div>}
      <div className="pm-grid">
        {(markets ?? []).map((m) => {
          const p = probs[m.id];
          return (
            <a key={m.id} className="pm-card pm-market-card" href={marketHref(m.id)}>
              <div className="pm-row pm-between">
                <span className={`pm-status ${m.status}`}>{m.status === "resolved" ? `resolved ${m.outcome?.toUpperCase()}` : m.status}</span>
                <span className="muted small">{timeLeft(m.resolution_time)}</span>
              </div>
              <h3>{m.question}</h3>
              {m.status === "active" && (
                <div className="pm-prob-row">
                  <div className="pm-prob-bar">
                    <div className="pm-prob-fill" style={{ width: `${((p ?? 0.5) * 100).toFixed(1)}%` }} />
                  </div>
                  <span className="pm-prob">{p !== undefined ? `${(p * 100).toFixed(0)}%` : "—"}</span>
                </div>
              )}
              {m.status === "failed" && <div className="muted small">{m.error}</div>}
            </a>
          );
        })}
      </div>
    </div>
  );
}
