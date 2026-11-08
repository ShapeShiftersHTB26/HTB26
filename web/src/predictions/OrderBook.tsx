import { useState } from "react";
import type { Books } from "./hooks";
import { Skeleton } from "./ui";
import { cents, fmt, Outcome, outcomeLabel, usd } from "./util";

const ROWS = 10; // the market maker quotes 10 levels a side, out to ±35¢

/** One outcome's book at a time: asks (sellers) above, bids (buyers) below, spread in between. */
export default function OrderBook({ books }: { books: Books }) {
  const [outcome, setOutcome] = useState<Outcome>("yes");
  const book = outcome === "yes" ? books.yes : books.no;
  const asks = (book?.asks ?? []).slice(0, ROWS).reverse();
  const bids = (book?.bids ?? []).slice(0, ROWS);
  const maxSize = Math.max(1, ...asks.map((l) => l.size), ...bids.map((l) => l.size));
  const bestAsk = book?.asks[0]?.price;
  const bestBid = book?.bids[0]?.price;

  return (
    <div className="pm-book">
      <div className="pm-book-bar">
        <div className="pm-seg pm-seg-sm">
          {(["yes", "no"] as const).map((o) => (
            <button key={o} className={outcome === o ? `on ${o}` : ""} onClick={() => setOutcome(o)}>
              Trade {outcomeLabel(o)}
            </button>
          ))}
        </div>
        <span className="pm-muted pm-small">Shares settle at $1 if {outcomeLabel(outcome)} wins</span>
      </div>
      <div className="pm-book-row pm-book-head">
        <span>Price</span>
        <span>Shares</span>
        <span>Total</span>
      </div>
      {!book &&
        Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="pm-book-row">
            <Skeleton h={14} />
          </div>
        ))}
      {asks.map((l) => (
        <div key={`a${l.price}`} className="pm-book-row pm-ask">
          <i style={{ width: `${(l.size / maxSize) * 100}%` }} />
          <span>{cents(l.price)}</span>
          <span>{fmt(l.size)}</span>
          <span>{usd(l.size * l.price)}</span>
        </div>
      ))}
      {book && (
        <div className="pm-book-spread">
          <span>{bestAsk !== undefined && bestBid !== undefined ? `Mid ${cents((bestAsk + bestBid) / 2)}` : "—"}</span>
          <span>{bestAsk !== undefined && bestBid !== undefined ? `Spread ${cents(bestAsk - bestBid)}` : ""}</span>
        </div>
      )}
      {bids.map((l) => (
        <div key={`b${l.price}`} className="pm-book-row pm-bid">
          <i style={{ width: `${(l.size / maxSize) * 100}%` }} />
          <span>{cents(l.price)}</span>
          <span>{fmt(l.size)}</span>
          <span>{usd(l.size * l.price)}</span>
        </div>
      ))}
      {book && !asks.length && !bids.length && <div className="pm-empty pm-small">No orders on this book right now.</div>}
    </div>
  );
}
