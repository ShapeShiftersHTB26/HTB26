import { useState } from "react";
import { BotTrade, MarketInfo, pmApi } from "./api";
import { useAppConfig } from "./context";
import { Balances, Books, useBalances, useBooks, usePoll } from "./hooks";
import OrderBook from "./OrderBook";
import PriceChart from "./PriceChart";
import { ensureAtasIxs, mergeSetIx, mintSetIx, newTx, redeemIx, TOKEN } from "./solana";
import TradePanel from "./TradePanel";
import { cents, fmt, timeLeft } from "./util";
import { useSigner } from "./wallet";

const toBase = (tokens: number) => BigInt(Math.round(tokens * TOKEN));
type Msg = { ok: boolean; text: string } | null;

export default function MarketPage({ id }: { id: number }) {
  const [market, setMarket] = useState<MarketInfo | null>(null);
  const [trades, setTrades] = useState<BotTrade[]>([]);
  const [err, setErr] = useState<string | null>(null);

  usePoll(
    async () => {
      try {
        const [m, t] = await Promise.all([pmApi.market(id), pmApi.trades(id)]);
        setMarket(m);
        setTrades(t.slice(0, 12));
        setErr(null);
      } catch (e) {
        setErr((e as Error).message);
      }
    },
    5000,
    [id],
  );

  const { books, history, refresh: refreshBooks } = useBooks(market?.status === "active" ? market : null);
  const { bal, refresh: refreshBal } = useBalances(market);
  const refreshAll = () => {
    refreshBooks();
    refreshBal();
  };

  if (err) return <div className="pm-card error">{err}</div>;
  if (!market) return <div className="pm-card">Loading…</div>;

  const closed = new Date(market.resolution_time).getTime() <= Date.now();
  const prob = books.prob;

  return (
    <div className="pm-market">
      <a href="#/predictions" className="muted small">← all markets</a>
      <div className="pm-market-head">
        <div>
          <h2>{market.question}</h2>
          {market.description && <p className="muted">{market.description}</p>}
          <div className="pm-row pm-gap">
            <span className={`pm-status ${market.status}`}>{market.status}</span>
            <span className="muted small">{timeLeft(market.resolution_time)}</span>
            <span className="muted small">resolves {new Date(market.resolution_time).toLocaleString()}</span>
            {market.query_hash && (
              <span className="muted small" title={`query hash ${market.query_hash}`}>
                #{market.id} · {market.query_hash.slice(0, 10)}…
              </span>
            )}
          </div>
        </div>
        {market.status === "active" && (
          <div className="pm-big-prob">
            <div className="pm-prob-num">{prob !== null ? `${(prob * 100).toFixed(0)}%` : "—"}</div>
            <div className="muted small">chance YES</div>
          </div>
        )}
        {market.status === "resolved" && (
          <div className={`pm-big-prob resolved ${market.outcome}`}>
            <div className="pm-prob-num">{market.outcome?.toUpperCase()}</div>
            <div className="muted small">resolved</div>
          </div>
        )}
      </div>

      {market.status === "failed" && <div className="pm-card error">Creation failed: {market.error}</div>}
      {market.status === "pending" && <div className="pm-card">Creating order books and seeding liquidity…</div>}

      {market.status === "active" && (
        <div className="pm-layout">
          <div className="pm-col">
            <div className="pm-card">
              <PriceChart points={history} />
            </div>
            <div className="pm-books">
              <OrderBook title="YES / mUSDC" book={books.yes} />
              <OrderBook title="NO / mUSDC" book={books.no} />
            </div>
            <TradesFeed trades={trades} />
          </div>
          <div className="pm-col">
            {closed ? (
              <div className="pm-card">Trading closed — waiting for resolution.</div>
            ) : (
              <TradePanel market={market} books={books} bal={bal} onDone={refreshAll} />
            )}
            <Positions bal={bal} books={books} />
            {!closed && <SetPanel market={market} bal={bal} onDone={refreshAll} />}
          </div>
        </div>
      )}

      {market.status === "resolved" && (
        <div className="pm-layout">
          <div className="pm-col">
            <Positions bal={bal} books={null} />
            <RedeemPanel market={market} bal={bal} onDone={refreshBal} />
          </div>
        </div>
      )}
    </div>
  );
}

function Positions({ bal, books }: { bal: Balances; books: Books | null }) {
  const yesMark = books?.prob ?? null;
  const value = yesMark !== null ? bal.yes * yesMark + bal.no * (1 - yesMark) : null;
  return (
    <div className="pm-card">
      <h4>Your position</h4>
      <div className="pm-row pm-between"><span className="muted">YES</span><span>{fmt(bal.yes)}</span></div>
      <div className="pm-row pm-between"><span className="muted">NO</span><span>{fmt(bal.no)}</span></div>
      <div className="pm-row pm-between"><span className="muted">mUSDC</span><span>{fmt(bal.usdc)}</span></div>
      {value !== null && (
        <div className="pm-row pm-between"><span className="muted">Position value (at mid)</span><span>{fmt(value)} mUSDC</span></div>
      )}
    </div>
  );
}

function SetPanel({ market, bal, onDone }: { market: MarketInfo; bal: Balances; onDone: () => void }) {
  const { addrs } = useAppConfig();
  const { publicKey, send } = useSigner();
  const [amount, setAmount] = useState("10");
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const n = Number(amount);

  const run = async (kind: "mint" | "merge") => {
    if (!publicKey || !(n > 0)) return;
    setBusy(true);
    setMsg(null);
    try {
      const ix = kind === "mint" ? mintSetIx(addrs, market, publicKey, toBase(n)) : mergeSetIx(addrs, market, publicKey, toBase(n));
      const sig = await send(newTx([...ensureAtasIxs(addrs, market, publicKey), ix]));
      setMsg({ ok: true, text: `${kind === "mint" ? "Minted" : "Merged"} ${fmt(n)} sets · ${sig.slice(0, 8)}…` });
      onDone();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="pm-card pm-details">
      <summary>Advanced: mint / merge sets</summary>
      <p className="muted small">1 mUSDC ⇄ 1 YES + 1 NO. Minting and selling the side you don't want is another way to take a position.</p>
      <label className="pm-field">
        <span>Sets</span>
        <input type="number" min="0.000001" step="1" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      <div className="pm-row pm-gap">
        <button className="pm-btn" disabled={busy || !publicKey || bal.usdc < n} onClick={() => run("mint")}>Mint</button>
        <button className="pm-btn" disabled={busy || !publicKey || Math.min(bal.yes, bal.no) < n} onClick={() => run("merge")}>Merge</button>
      </div>
      {msg && <div className={msg.ok ? "pm-ok small" : "error small"}>{msg.text}</div>}
    </details>
  );
}

function RedeemPanel({ market, bal, onDone }: { market: MarketInfo; bal: Balances; onDone: () => void }) {
  const { addrs } = useAppConfig();
  const { publicKey, send } = useSigner();
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const payout = market.outcome === "yes" ? bal.yes : market.outcome === "no" ? bal.no : (bal.yes + bal.no) / 2;

  const redeem = async () => {
    if (!publicKey) return;
    setBusy(true);
    setMsg(null);
    try {
      const sig = await send(
        newTx([...ensureAtasIxs(addrs, market, publicKey), redeemIx(addrs, market, publicKey, toBase(bal.yes), toBase(bal.no))]),
      );
      setMsg({ ok: true, text: `Redeemed ${fmt(payout)} mUSDC · ${sig.slice(0, 8)}…` });
      onDone();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pm-card">
      <h4>Redeem</h4>
      <p className="muted small">
        {market.outcome === "void"
          ? "Market voided: every YES and NO token redeems for 0.50 mUSDC."
          : `Each ${market.outcome?.toUpperCase()} token redeems for 1 mUSDC; the other side is worth 0.`}
      </p>
      <button className="pm-btn pm-primary" disabled={busy || !publicKey || bal.yes + bal.no === 0} onClick={redeem}>
        {busy ? "Redeeming…" : `Redeem all → ${fmt(payout)} mUSDC`}
      </button>
      {msg && <div className={msg.ok ? "pm-ok small" : "error small"}>{msg.text}</div>}
    </div>
  );
}

function TradesFeed({ trades }: { trades: BotTrade[] }) {
  if (!trades.length) return null;
  return (
    <div className="pm-card">
      <h4>Recent bot orders</h4>
      <table className="pm-trades">
        <tbody>
          {trades.map((t) => (
            <tr key={t.id}>
              <td className={t.side === "buy" ? "pm-ok" : "error"}>{t.side}</td>
              <td>{t.book.toUpperCase()}</td>
              <td>{fmt(t.size_lots / 100)}</td>
              <td>limit {cents(t.limit_cents / 100)}</td>
              <td className="muted">{new Date(t.created_at).toLocaleTimeString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
