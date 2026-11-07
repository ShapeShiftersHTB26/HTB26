import { useState } from 'react';
import { api, BotTrade, MarketInfo } from '../api';
import { Balances, useBalances, useBooks, usePoll } from '../hooks';
import { useAppConfig } from '../main';
import { ensureAtasIxs, mergeSetIx, mintSetIx, newTx, redeemIx, TOKEN } from '../solana';
import { useSigner } from '../wallet';
import OrderBook from './OrderBook';
import PriceChart from './PriceChart';
import TradePanel from './TradePanel';
import { cents, fmt, timeLeft } from './util';

const toBase = (tokens: number) => BigInt(Math.round(tokens * TOKEN));

export default function MarketPage({ id }: { id: number }) {
  const [market, setMarket] = useState<MarketInfo | null>(null);
  const [trades, setTrades] = useState<BotTrade[]>([]);
  const [err, setErr] = useState<string | null>(null);

  usePoll(
    async () => {
      try {
        const [m, t] = await Promise.all([api.market(id), api.trades(id)]);
        setMarket(m);
        setTrades(t.slice(0, 12));
      } catch (e) {
        setErr((e as Error).message);
      }
    },
    5000,
    [id],
  );

  const { books, history, refresh: refreshBooks } = useBooks(market?.status === 'active' ? market : null);
  const { bal, refresh: refreshBal } = useBalances(market);
  const refreshAll = () => {
    refreshBooks();
    refreshBal();
  };

  if (err) return <div className="card error">{err}</div>;
  if (!market) return <div className="card">Loading…</div>;

  const closed = new Date(market.resolution_time).getTime() <= Date.now();
  const prob = books.prob;

  return (
    <div className="market">
      <a href="#/" className="muted small">← all markets</a>
      <div className="market-head">
        <div>
          <h2>{market.question}</h2>
          {market.description && <p className="muted">{market.description}</p>}
          <div className="row gap">
            <span className={`status ${market.status}`}>{market.status}</span>
            <span className="muted small">{timeLeft(market.resolution_time)}</span>
            <span className="muted small">resolves {new Date(market.resolution_time).toLocaleString()}</span>
          </div>
        </div>
        {market.status === 'active' && (
          <div className="big-prob">
            <div className="prob-num">{prob !== null ? `${(prob * 100).toFixed(0)}%` : '—'}</div>
            <div className="muted small">chance YES</div>
          </div>
        )}
        {market.status === 'resolved' && (
          <div className={`big-prob resolved ${market.outcome}`}>
            <div className="prob-num">{market.outcome?.toUpperCase()}</div>
            <div className="muted small">resolved</div>
          </div>
        )}
      </div>

      {market.status === 'failed' && <div className="card error">Creation failed: {market.error}</div>}

      {market.status === 'active' && (
        <div className="layout">
          <div className="col">
            <div className="card">
              <PriceChart points={history} />
            </div>
            <div className="books">
              <OrderBook title="YES / mUSDC" book={books.yes} tone="yes" />
              <OrderBook title="NO / mUSDC" book={books.no} tone="no" />
            </div>
            <TradesFeed trades={trades} />
          </div>
          <div className="col side">
            {closed ? (
              <div className="card">Trading closed — waiting for resolution.</div>
            ) : (
              <TradePanel market={market} books={books} bal={bal} onDone={refreshAll} />
            )}
            <Positions bal={bal} books={books} />
            {!closed && <SetPanel market={market} bal={bal} onDone={refreshAll} />}
          </div>
        </div>
      )}

      {market.status === 'resolved' && (
        <div className="layout">
          <div className="col side">
            <Positions bal={bal} books={null} />
            <RedeemPanel market={market} bal={bal} onDone={refreshBal} />
          </div>
        </div>
      )}
    </div>
  );
}

function Positions({ bal, books }: { bal: Balances; books: ReturnType<typeof useBooks>['books'] | null }) {
  const yesMark = books?.prob ?? null;
  const value = yesMark !== null ? bal.yes * yesMark + bal.no * (1 - yesMark) : null;
  return (
    <div className="card">
      <h4>Your position</h4>
      <div className="row between"><span className="muted">YES</span><span>{fmt(bal.yes)}</span></div>
      <div className="row between"><span className="muted">NO</span><span>{fmt(bal.no)}</span></div>
      <div className="row between"><span className="muted">mUSDC</span><span>{fmt(bal.usdc)}</span></div>
      {value !== null && (
        <div className="row between"><span className="muted">Position value (at mid)</span><span>{fmt(value)} mUSDC</span></div>
      )}
    </div>
  );
}

function SetPanel({ market, bal, onDone }: { market: MarketInfo; bal: Balances; onDone: () => void }) {
  const { addrs } = useAppConfig();
  const { publicKey, send } = useSigner();
  const [amount, setAmount] = useState('10');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const n = Number(amount);

  const run = async (kind: 'mint' | 'merge') => {
    if (!publicKey || !(n > 0)) return;
    setBusy(true);
    setMsg(null);
    try {
      const ix = kind === 'mint' ? mintSetIx(addrs, market, publicKey, toBase(n)) : mergeSetIx(addrs, market, publicKey, toBase(n));
      const sig = await send(newTx([...ensureAtasIxs(addrs, market, publicKey), ix]));
      setMsg({ ok: true, text: `${kind === 'mint' ? 'Minted' : 'Merged'} ${fmt(n)} sets · ${sig.slice(0, 8)}…` });
      onDone();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="card">
      <summary>Advanced: mint / merge sets</summary>
      <p className="muted small">1 mUSDC ⇄ 1 YES + 1 NO. Minting and selling the side you don't want is another way to take a position.</p>
      <label className="field">
        <span>Sets</span>
        <input type="number" min="0.000001" step="1" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      <div className="row gap">
        <button className="btn" disabled={busy || !publicKey || bal.usdc < n} onClick={() => run('mint')}>Mint</button>
        <button className="btn" disabled={busy || !publicKey || Math.min(bal.yes, bal.no) < n} onClick={() => run('merge')}>Merge</button>
      </div>
      {msg && <div className={msg.ok ? 'ok small' : 'error small'}>{msg.text}</div>}
    </details>
  );
}

function RedeemPanel({ market, bal, onDone }: { market: MarketInfo; bal: Balances; onDone: () => void }) {
  const { addrs } = useAppConfig();
  const { publicKey, send } = useSigner();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const payout =
    market.outcome === 'yes' ? bal.yes : market.outcome === 'no' ? bal.no : (bal.yes + bal.no) / 2;

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
    <div className="card">
      <h4>Redeem</h4>
      <p className="muted small">
        {market.outcome === 'void'
          ? 'Market voided: every YES and NO token redeems for 0.50 mUSDC.'
          : `Each ${market.outcome?.toUpperCase()} token redeems for 1 mUSDC; the other side is worth 0.`}
      </p>
      <button className="btn primary" disabled={busy || !publicKey || bal.yes + bal.no === 0} onClick={redeem}>
        {busy ? 'Redeeming…' : `Redeem all → ${fmt(payout)} mUSDC`}
      </button>
      {msg && <div className={msg.ok ? 'ok small' : 'error small'}>{msg.text}</div>}
    </div>
  );
}

function TradesFeed({ trades }: { trades: BotTrade[] }) {
  if (!trades.length) return null;
  return (
    <div className="card">
      <h4>Recent bot orders</h4>
      <table className="trades">
        <tbody>
          {trades.map((t) => (
            <tr key={t.id}>
              <td className={t.side === 'buy' ? 'ok' : 'error'}>{t.side}</td>
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
