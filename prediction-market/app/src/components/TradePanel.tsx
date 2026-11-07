import { useMemo, useState } from 'react';
import type { MarketInfo } from '../api';
import type { Balances, Books } from '../hooks';
import { useAppConfig } from '../main';
import { BASE_LOTS_PER_TOKEN, bookAddrs, ensureAtasIxs, estimateFill, newTx, placeTakeOrderIx } from '../solana';
import { useSigner } from '../wallet';
import { cents, fmt } from './util';

type Outcome = 'yes' | 'no';
type Side = 'buy' | 'sell';

export default function TradePanel({
  market,
  books,
  bal,
  onDone,
}: {
  market: MarketInfo;
  books: Books;
  bal: Balances;
  onDone: () => void;
}) {
  const { addrs } = useAppConfig();
  const { publicKey, send } = useSigner();
  const [outcome, setOutcome] = useState<Outcome>('yes');
  const [side, setSide] = useState<Side>('buy');
  const [amount, setAmount] = useState('10');
  const [slippage, setSlippage] = useState(2); // cents beyond best price
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const book = outcome === 'yes' ? books.yes : books.no;
  const size = Math.max(0, Math.floor(Number(amount) * 100) / 100); // 0.01 token lots
  const best = side === 'buy' ? book?.asks[0]?.price : book?.bids[0]?.price;
  const limitCents = best === undefined ? null : Math.min(99, Math.max(1, Math.round(best * 100) + (side === 'buy' ? slippage : -slippage)));

  const est = useMemo(() => {
    if (!book || limitCents === null) return null;
    return estimateFill(side === 'buy' ? book.asks : book.bids, size, limitCents / 100, side);
  }, [book, side, size, limitCents]);

  const held = outcome === 'yes' ? bal.yes : bal.no;
  const problem =
    !publicKey ? 'Connect a wallet or use the burner wallet' :
    size < 0.01 ? 'Minimum order is 0.01' :
    limitCents === null ? 'No liquidity on this side' :
    side === 'sell' && held < size ? `You hold ${fmt(held)} ${outcome.toUpperCase()}` :
    side === 'buy' && est && bal.usdc < est.total ? 'Not enough mUSDC — use the faucet' : null;

  const submit = async () => {
    if (!publicKey || limitCents === null || problem) return;
    setBusy(true);
    setMsg(null);
    try {
      const row = outcome === 'yes' ? market.yes_book! : market.no_book!;
      const mint = outcome === 'yes' ? market.yes_mint! : market.no_mint!;
      const baseLots = Math.round(size * BASE_LOTS_PER_TOKEN);
      const tx = newTx([
        ...ensureAtasIxs(addrs, market, publicKey),
        placeTakeOrderIx(addrs, bookAddrs(row, mint), publicKey, side, limitCents, baseLots),
      ]);
      const sig = await send(tx);
      setMsg({ ok: true, text: `${side === 'buy' ? 'Bought' : 'Sold'} up to ${fmt(size)} ${outcome.toUpperCase()} · ${sig.slice(0, 8)}…` });
      onDone();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card trade">
      <div className="seg">
        <button className={outcome === 'yes' ? 'on yes' : ''} onClick={() => setOutcome('yes')}>
          YES {books.yes?.asks[0] ? cents(books.yes.asks[0].price) : ''}
        </button>
        <button className={outcome === 'no' ? 'on no' : ''} onClick={() => setOutcome('no')}>
          NO {books.no?.asks[0] ? cents(books.no.asks[0].price) : ''}
        </button>
      </div>
      <div className="seg small-seg">
        <button className={side === 'buy' ? 'on' : ''} onClick={() => setSide('buy')}>Buy</button>
        <button className={side === 'sell' ? 'on' : ''} onClick={() => setSide('sell')}>Sell</button>
      </div>
      <label className="field">
        <span>Shares</span>
        <input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      <label className="field">
        <span>Max slippage</span>
        <select value={slippage} onChange={(e) => setSlippage(Number(e.target.value))}>
          {[0, 1, 2, 3, 5, 10].map((s) => (
            <option key={s} value={s}>{s}¢</option>
          ))}
        </select>
      </label>
      <div className="summary">
        <div className="row between"><span className="muted">Limit price</span><span>{limitCents !== null ? `${limitCents}¢` : '—'}</span></div>
        <div className="row between"><span className="muted">Est. fill</span><span>{est ? `${fmt(est.filled)} @ ${cents(est.avgPrice)}` : '—'}</span></div>
        <div className="row between">
          <span className="muted">{side === 'buy' ? 'Est. cost' : 'Est. proceeds'}</span>
          <span>{est ? `${fmt(est.total)} mUSDC` : '—'}</span>
        </div>
        {side === 'buy' && est && est.filled > 0 && (
          <div className="row between"><span className="muted">Payout if {outcome.toUpperCase()}</span><span>{fmt(est.filled)} mUSDC</span></div>
        )}
      </div>
      <button className={`btn primary ${outcome}`} disabled={busy || !!problem} onClick={submit}>
        {busy ? 'Sending…' : problem ?? `${side === 'buy' ? 'Buy' : 'Sell'} ${outcome.toUpperCase()}`}
      </button>
      {msg && <div className={msg.ok ? 'ok small' : 'error small'}>{msg.text}</div>}
      <div className="muted small">Immediate-or-cancel order on the {outcome.toUpperCase()}/mUSDC OpenBook market; unfilled size is cancelled.</div>
    </div>
  );
}

