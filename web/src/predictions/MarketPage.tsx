import { useEffect, useState } from "react";
import type { MarketInfo } from "./api";
import { useAppConfig } from "./context";
import { Balances, Books, ProbPoint, useBalances, useBooks, useMarket, useTrades, useTx } from "./hooks";
import { InsightsBody } from "./Insights";
import { useMode } from "./mode";
import OrderBook from "./OrderBook";
import PriceChart from "./PriceChart";
import Rules from "./Rules";
import { ensureAtasIxs, mergeSetIx, mintSetIx, newTx, redeemIx, TOKEN } from "./solana";
import TradePanel from "./TradePanel";
import { Skeleton, Spinner, useTween } from "./ui";
import { ago, cents, countdown, dateLabel, fmt, Outcome, outcomeLabel, pct, phase, usd } from "./util";
import { useSigner } from "./wallet";

const toBase = (tokens: number) => BigInt(Math.round(tokens * TOKEN));

export default function MarketPage({ id }: { id: number }) {
  const { mode, setMode } = useMode();
  const { market, err } = useMarket(id);
  const p = market ? phase(market) : null;
  const live = p === "open" || p === "awaiting";
  const { books, history, refresh: refreshBooks } = useBooks(live ? market : null);
  const { bal, refresh: refreshBal } = useBalances(market);
  // "Buy Yes" / "Buy No" on a trading card preselects the outcome (and such a link always opens the trading view).
  const [initialOutcome] = useState<Outcome | null>(() => (window.location.hash.match(/[?&]buy=(yes|no)/)?.[1] as Outcome) ?? null);
  useEffect(() => {
    if (initialOutcome) setMode("trading");
  }, [initialOutcome, setMode]);

  if (!market) {
    return err ? (
      <div className="pm-banner err">Couldn't load this market: {err}</div>
    ) : (
      <div className="pm-market">
        <Skeleton h={14} w={90} />
        <div style={{ height: 16 }} />
        <Skeleton h={34} w="70%" />
        <div style={{ height: 24 }} />
        <div className="pm-layout">
          <Skeleton h={340} r={14} />
          <Skeleton h={340} r={14} />
        </div>
      </div>
    );
  }

  return (
    <div className={`pm-market pm-market-${mode}`}>
      <a className="pm-back" href="#/predictions">← Markets</a>
      <div className="pm-mhead">
        <div className="pm-mhead-meta">
          <PhaseChip m={market} />
          <span>{p === "open" || p === "pending" ? `Closes ${dateLabel(market.resolution_time)}` : `Closed ${dateLabel(market.resolution_time)}`}</span>
          <span>#{market.id}</span>
        </div>
        <h1>{market.question}</h1>
      </div>

      {p === "pending" && (
        <div className="pm-banner">
          <Spinner /> Creating the order books and seeding liquidity. This takes a few seconds.
        </div>
      )}
      {p === "failed" && <div className="pm-banner err">This market couldn't be created: {market.error}</div>}

      {(live || p === "resolved") &&
        (mode === "insights" ? (
          <InsightsBody market={market} books={books} history={history} />
        ) : (
          <TradingBody
            market={market}
            books={books}
            history={history}
            bal={bal}
            initialOutcome={initialOutcome ?? "yes"}
            onTraded={() => (refreshBooks(), refreshBal())}
          />
        ))}
    </div>
  );
}

/** Trading view: chart, order book, trade panel, positions. */
function TradingBody({
  market,
  books,
  history,
  bal,
  initialOutcome,
  onTraded,
}: {
  market: MarketInfo;
  books: Books;
  history: ProbPoint[];
  bal: Balances;
  initialOutcome: Outcome;
  onTraded: () => void;
}) {
  const p = phase(market);
  const live = p === "open" || p === "awaiting";
  return (
    <div className="pm-layout">
      <div className="pm-col">
        {live && (
          <div className="pm-card pm-chart-card">
            <div className="pm-prob-head">
              <BigProb p={books.prob} />
              <Delta from={history[0]?.p} to={books.prob} />
              <span className="pm-live">
                <i /> Live
              </span>
            </div>
            <PriceChart points={history} current={books.prob} />
          </div>
        )}
        {p === "resolved" && <ResolvedBanner m={market} />}
        <DetailTabs market={market} books={books} live={live} />
      </div>

      <aside className="pm-col pm-side">
        {p === "open" && (
          <TradePanel
            market={market}
            books={books}
            bal={bal}
            initialOutcome={initialOutcome}
            onDone={onTraded}
          />
        )}
        {p === "awaiting" && (
          <div className="pm-card pm-note-card">
            <h4>Trading closed</h4>
            <p>
              This market closed {dateLabel(market.resolution_time)}. Once the result is posted you can redeem winning shares
              here.
            </p>
          </div>
        )}
        {p === "resolved" && <RedeemPanel market={market} bal={bal} />}
        <Positions market={market} bal={bal} books={live ? books : null} />
        {p === "open" && <SplitMerge market={market} bal={bal} />}
      </aside>
    </div>
  );
}

function PhaseChip({ m }: { m: MarketInfo }) {
  const p = phase(m);
  const left = countdown(m.resolution_time);
  const label =
    p === "open"
      ? left
        ? `${left} left`
        : "Open"
      : p === "awaiting"
        ? "Awaiting result"
        : p === "resolved"
          ? `Resolved ${m.outcome === "void" ? "Void" : outcomeLabel(m.outcome as Outcome)}`
          : p === "pending"
            ? "Launching"
            : "Failed";
  return <span className={`pm-chip ${p}`}>{label}</span>;
}

function BigProb({ p }: { p: number | null }) {
  const v = useTween(p);
  return (
    <div className="pm-bigprob">
      <b>{v === null ? "—" : `${Math.round(v * 100)}%`}</b>
      <span>chance</span>
    </div>
  );
}

function Delta({ from, to }: { from?: number; to: number | null }) {
  if (from === undefined || to === null || Math.abs(to - from) < 0.001) return null;
  const up = to > from;
  return (
    <span className={`pm-delta ${up ? "up" : "down"}`} title="Change since you opened this market">
      {up ? "▲" : "▼"} {pct(Math.abs(to - from), 1)}
    </span>
  );
}

function ResolvedBanner({ m }: { m: MarketInfo }) {
  return (
    <div className={`pm-card pm-resolved ${m.outcome}`}>
      <span className="pm-resolved-label">Final outcome</span>
      <b>{m.outcome === "void" ? "Void" : outcomeLabel(m.outcome as Outcome)}</b>
      <span className="pm-muted">
        {m.outcome === "void" ? "Every Yes and No share redeems for 50¢." : `Each ${outcomeLabel(m.outcome as Outcome)} share redeems for $1.`}
        {m.resolved_at && ` Resolved ${dateLabel(m.resolved_at)}.`}
      </span>
    </div>
  );
}

// ---------------- tabs: order book · activity · rules ----------------

type Tab = "book" | "activity" | "rules";
const TAB_LABELS: Record<Tab, string> = { book: "Order book", activity: "Activity", rules: "Rules" };

function DetailTabs({ market, books, live }: { market: MarketInfo; books: Books; live: boolean }) {
  const tabs: Tab[] = live ? ["book", "activity", "rules"] : ["activity", "rules"];
  const [picked, setPicked] = useState<Tab>(tabs[0]);
  const tab = tabs.includes(picked) ? picked : tabs[0]; // e.g. the book tab disappears once the market resolves
  return (
    <div className="pm-card pm-details">
      <div className="pm-tabs pm-tabs-sm pm-tabs-line">
        {tabs.map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => setPicked(t)}>
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>
      {tab === "book" && <OrderBook books={books} />}
      {tab === "activity" && <Activity id={market.id} />}
      {tab === "rules" && <Rules m={market} />}
    </div>
  );
}

function Activity({ id }: { id: number }) {
  const trades = useTrades(id, 5000);
  if (!trades) return <Skeleton h={120} />;
  if (!trades.length) return <div className="pm-empty pm-small">No trades yet.</div>;
  return (
    <ul className="pm-activity">
      {trades.slice(0, 20).map((t) => (
        <li key={t.id}>
          <span className={`pm-act-side ${t.side}`}>{t.side === "buy" ? "Bought" : "Sold"}</span>
          <span className={`pm-act-outcome ${t.book}`}>{outcomeLabel(t.book)}</span>
          <span>{fmt(t.size_lots / 100)} shares</span>
          <span className="pm-muted">limit {cents(t.limit_cents / 100)}</span>
          <span className="pm-muted pm-act-time">{ago(t.created_at)}</span>
        </li>
      ))}
      <li className="pm-muted pm-small">Orders by the demo market-taker bots.</li>
    </ul>
  );
}


// ---------------- side column: position · redeem · split/merge ----------------

function Positions({ market, bal, books }: { market: MarketInfo; bal: Balances; books: Books | null }) {
  const { publicKey } = useSigner();
  if (!publicKey) return null;
  const resolved = market.status === "resolved";
  const mark = (o: Outcome): number | null =>
    resolved
      ? market.outcome === "void"
        ? 0.5
        : market.outcome === o
          ? 1
          : 0
      : books?.prob != null
        ? o === "yes"
          ? books.prob
          : 1 - books.prob
        : null;
  const rows = (["yes", "no"] as const).filter((o) => (o === "yes" ? bal.yes : bal.no) > 0);
  return (
    <div className="pm-card pm-positions">
      <h4>Your position</h4>
      {!rows.length && <p className="pm-muted pm-small">You don't hold any shares in this market yet.</p>}
      {rows.map((o) => {
        const shares = o === "yes" ? bal.yes : bal.no;
        const m = mark(o);
        return (
          <div key={o} className="pm-pos">
            <span className={`pm-pos-tag ${o}`}>{outcomeLabel(o)}</span>
            <span>{fmt(shares)} shares{m !== null && <span className="pm-muted"> · {cents(m)}</span>}</span>
            <b>{m !== null ? usd(shares * m) : "—"}</b>
          </div>
        );
      })}
      <div className="pm-pos pm-pos-cash">
        <span className="pm-muted">Cash</span>
        <span />
        <b>{usd(bal.usdc)}</b>
      </div>
    </div>
  );
}

function RedeemPanel({ market, bal }: { market: MarketInfo; bal: Balances }) {
  const { addrs } = useAppConfig();
  const { publicKey } = useSigner();
  const tx = useTx();
  const payout = market.outcome === "yes" ? bal.yes : market.outcome === "no" ? bal.no : (bal.yes + bal.no) / 2;
  const hasShares = bal.yes + bal.no > 0;

  const redeem = () =>
    publicKey &&
    tx.run(
      newTx([...ensureAtasIxs(addrs, market, publicKey), redeemIx(addrs, market, publicKey, toBase(bal.yes), toBase(bal.no))]),
      `Redeemed ${usd(payout)}`,
    );

  return (
    <div className="pm-card pm-redeem">
      <h4>Redeem</h4>
      {!publicKey ? (
        <p className="pm-muted pm-small">Connect the wallet that holds your shares to redeem.</p>
      ) : hasShares ? (
        <>
          <div className="pm-redeem-amount">{usd(payout)}</div>
          <button className="pm-btn pm-btn-primary pm-btn-block pm-btn-lg" disabled={tx.busy} onClick={redeem}>
            {tx.busy ? (
              <>
                <Spinner /> Redeeming…
              </>
            ) : (
              `Redeem ${usd(payout)}`
            )}
          </button>
        </>
      ) : (
        <p className="pm-muted pm-small">Nothing to redeem in this wallet.</p>
      )}
    </div>
  );
}

function SplitMerge({ market, bal }: { market: MarketInfo; bal: Balances }) {
  const { addrs } = useAppConfig();
  const { publicKey } = useSigner();
  const tx = useTx();
  const [amount, setAmount] = useState("10");
  const n = Number(amount) || 0;
  if (!publicKey) return null;

  const run = (kind: "split" | "merge") => {
    if (!publicKey || n <= 0) return;
    const ix = kind === "split" ? mintSetIx(addrs, market, publicKey, toBase(n)) : mergeSetIx(addrs, market, publicKey, toBase(n));
    tx.run(
      newTx([...ensureAtasIxs(addrs, market, publicKey), ix]),
      kind === "split" ? `Split ${usd(n)} into ${fmt(n)} Yes + ${fmt(n)} No` : `Merged ${fmt(n)} Yes + No into ${usd(n)}`,
    );
  };

  return (
    <details className="pm-card pm-advanced">
      <summary>Split &amp; merge</summary>
      <p className="pm-muted pm-small">$1 mUSDC ⇄ 1 Yes + 1 No share. Split to get both sides, or merge a pair back into cash.</p>
      <div className="pm-amount pm-amount-sm">
        <span className="pm-amount-input">
          <span className="pm-amount-unit">$</span>
          <input
            inputMode="decimal"
            aria-label="Amount in mUSDC"
            style={{ width: `${Math.max(1, amount.length) + 0.3}ch` }}
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
          />
        </span>
      </div>
      <div className="pm-row-2">
        <button className="pm-btn pm-btn-soft" disabled={tx.busy || !publicKey || n <= 0 || bal.usdc < n} onClick={() => run("split")}>
          Split
        </button>
        <button className="pm-btn pm-btn-soft" disabled={tx.busy || !publicKey || n <= 0 || Math.min(bal.yes, bal.no) < n} onClick={() => run("merge")}>
          Merge
        </button>
      </div>
    </details>
  );
}
