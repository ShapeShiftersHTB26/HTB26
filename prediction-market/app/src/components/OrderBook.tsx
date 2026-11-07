import type { L2 } from '../solana';
import { cents, fmt } from './util';

export default function OrderBook({ title, book, tone }: { title: string; book: L2 | null; tone: 'yes' | 'no' }) {
  const rows = 6;
  const asks = (book?.asks ?? []).slice(0, rows).reverse();
  const bids = (book?.bids ?? []).slice(0, rows);
  const maxSize = Math.max(1, ...asks.map((l) => l.size), ...bids.map((l) => l.size));
  const spread = book?.asks[0] && book?.bids[0] ? book.asks[0].price - book.bids[0].price : null;

  return (
    <div className={`card book ${tone}`}>
      <div className="row between">
        <h4>{title}</h4>
        <span className="muted small">{spread !== null ? `spread ${cents(spread)}` : ''}</span>
      </div>
      <div className="book-head muted small">
        <span>Price</span>
        <span>Size</span>
      </div>
      {!book && <div className="muted small">loading…</div>}
      {asks.map((l) => (
        <div key={`a${l.price}`} className="book-row ask">
          <div className="depth" style={{ width: `${(l.size / maxSize) * 100}%` }} />
          <span>{cents(l.price)}</span>
          <span>{fmt(l.size)}</span>
        </div>
      ))}
      <div className="book-mid" />
      {bids.map((l) => (
        <div key={`b${l.price}`} className="book-row bid">
          <div className="depth" style={{ width: `${(l.size / maxSize) * 100}%` }} />
          <span>{cents(l.price)}</span>
          <span>{fmt(l.size)}</span>
        </div>
      ))}
      {book && !asks.length && !bids.length && <div className="muted small">empty book</div>}
    </div>
  );
}
