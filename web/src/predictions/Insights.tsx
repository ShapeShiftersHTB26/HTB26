// Insights mode: the same markets, read-only and in plain language — the odds, how they've moved, how solid they
// are, and how the question resolves. No order books, no trade panel.
import type { MarketInfo } from "./api";
import DataSettled, { isDataSettled } from "./DataSettled";
import { bookStats, Books, ProbPoint, useTrades } from "./hooks";
import { useMode } from "./mode";
import PriceChart from "./PriceChart";
import Rules from "./Rules";
import { useTween } from "./ui";
import { cents, countdown, dateLabel, lean, likelihood, marketHref, Outcome, outcomeLabel, phase, roughly, usd } from "./util";

const pts = (d: number) => `${d > 0 ? "+" : d < 0 ? "−" : ""}${Math.abs(Math.round(d * 100))} pts`;

/** Yes/No split as a bar with a legend underneath. */
function SplitBar({ p }: { p: number | null }) {
  const yes = p === null ? 50 : Math.round(p * 100);
  return (
    <div className="pm-split-wrap">
      <div className="pm-split" aria-hidden>
        <i style={{ width: `${p === null ? 50 : p * 100}%` }} />
      </div>
      <div className="pm-split-legend">
        <span className="yes">Yes {p === null ? "—" : `${yes}%`}</span>
        <span className="no">No {p === null ? "—" : `${100 - yes}%`}</span>
      </div>
    </div>
  );
}

function LeanPill({ p }: { p: number }) {
  return <span className={`pm-lean ${lean(p)}`}>{likelihood(p)}</span>;
}

// ---------------- list card ----------------

export function InsightCard({ m, prob }: { m: MarketInfo; prob: number | null }) {
  const p = phase(m);
  const v = useTween(prob);
  const moved = prob !== null ? prob - m.initial_price_cents / 100 : null;
  return (
    <a className={`pm-mcard pm-icard ${p}`} href={marketHref(m.id)}>
      <h3>{m.question}</h3>
      {p === "resolved" ? (
        <div className="pm-icard-prob">
          <b className={`pm-final ${m.outcome}`}>{m.outcome === "void" ? "Void" : outcomeLabel(m.outcome as Outcome)}</b>
          <span className="pm-muted">final result</span>
        </div>
      ) : p === "pending" || p === "failed" ? (
        <div className="pm-icard-prob">
          <span className="pm-muted">{p === "pending" ? "Opening soon…" : "Unavailable"}</span>
        </div>
      ) : (
        <>
          <div className="pm-icard-prob">
            <b>{v === null ? "—" : `${Math.round(v * 100)}%`}</b>
            {v !== null && <LeanPill p={v} />}
          </div>
          <SplitBar p={v} />
        </>
      )}
      <div className="pm-mcard-foot">
        {moved !== null && p !== "resolved" && Math.abs(moved) >= 0.005 ? (
          <span className={moved > 0 ? "pm-up" : "pm-down"}>
            {moved > 0 ? "▲" : "▼"} {pts(moved).replace(/^[+−]/, "")} since launch
          </span>
        ) : (
          <span>{p === "resolved" && m.resolved_at ? `Resolved ${dateLabel(m.resolved_at)}` : "No change since launch"}</span>
        )}
        <span>
          {isDataSettled(m) && <span className="pm-data-badge" title="Settles automatically from a Backtrace calculation">by data</span>}
          {p === "open" ? `${countdown(m.resolution_time) ?? "Closing"} left` : p === "awaiting" ? "Awaiting result" : `#${m.id}`}
        </span>
      </div>
    </a>
  );
}

// ---------------- market page ----------------

function Stat({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: string }) {
  return (
    <div className="pm-stat">
      <span className="pm-stat-label">{label}</span>
      <b className={tone}>{value}</b>
      <span className="pm-stat-sub">{sub}</span>
    </div>
  );
}

function TradeCta({ resolved }: { resolved?: boolean }) {
  const { setMode } = useMode();
  return (
    <div className="pm-cta">
      <div>
        <b>{resolved ? "Holding shares in this market?" : "Have a view on this?"}</b>
        <span className="pm-muted">
          {resolved ? "Redeem winning shares from the trading view." : "Take a position in the trading view: order books, prices and your portfolio."}
        </span>
      </div>
      <button
        className="pm-btn pm-btn-soft"
        onClick={() => {
          setMode("trading");
          document.querySelector(".pm")?.scrollTo({ top: 0 });
        }}
      >
        Open trading view →
      </button>
    </div>
  );
}

export function InsightsBody({ market, books, history }: { market: MarketInfo; books: Books; history: ProbPoint[] }) {
  const p = phase(market);
  const trades = useTrades(market.id);
  const v = useTween(books.prob);

  if (p === "resolved") {
    const o = market.outcome;
    return (
      <div className="pm-insights">
        <div className={`pm-card pm-ihero pm-ihero-final ${o}`}>
          <span className="pm-kicker">Final result</span>
          <b className={`pm-final ${o}`}>{o === "void" ? "Void" : outcomeLabel(o as Outcome)}</b>
          <p>
            {o === "void"
              ? "This question was voided, so every share paid out 50¢."
              : `This question resolved ${outcomeLabel(o as Outcome)}${market.resolved_at ? ` on ${dateLabel(market.resolved_at)}` : ""}. It opened at a ${Math.round(market.initial_price_cents)}% chance.`}
          </p>
        </div>
        <DataSettled market={market} />
        <div className="pm-card">
          <h4>How it resolved</h4>
          <Rules m={market} />
        </div>
        <TradeCta resolved />
      </div>
    );
  }

  const launch = market.initial_price_cents / 100;
  const moved = books.prob !== null ? books.prob - launch : null;
  const { spread, liquidity } = bookStats(books);
  const readings = history.map((h) => h.p);
  const lo = readings.length ? Math.min(...readings) : null;
  const hi = readings.length ? Math.max(...readings) : null;
  const hourAgo = Date.now() - 3600_000;
  const recent = trades ? trades.filter((t) => new Date(t.created_at).getTime() > hourAgo).length : null;
  const left = countdown(market.resolution_time);
  const spreadCents = spread === null ? null : Math.round(spread * 100); // whole cents: 0.83 − 0.81 isn't exactly 0.02
  const agreement = spreadCents === null ? "—" : spreadCents <= 2 ? "Strong" : spreadCents <= 5 ? "Moderate" : "Weak";

  return (
    <div className="pm-insights">
      <div className="pm-card pm-ihero">
        <div className="pm-ihero-top">
          <span className="pm-kicker">{p === "awaiting" ? "Last market chance · waiting for the official result" : "Chance of Yes, according to the market"}</span>
          <span className="pm-live">
            <i /> Live
          </span>
        </div>
        <div className="pm-ihero-prob">
          <b>{v === null ? "—" : `${Math.round(v * 100)}%`}</b>
          {v !== null && <LeanPill p={v} />}
        </div>
        <p className="pm-ihero-plain">
          {v === null ? (
            "Reading the order books…"
          ) : (
            <>
              Traders put this at <b>{roughly(v)}</b>.
              {moved !== null && Math.abs(moved) >= 0.005
                ? ` That's ${Math.abs(Math.round(moved * 100))} points ${moved > 0 ? "higher" : "lower"} than when the market opened at ${Math.round(launch * 100)}%.`
                : ` That's about where it opened (${Math.round(launch * 100)}%).`}
            </>
          )}
        </p>
        <SplitBar p={v} />
        <PriceChart points={history} current={books.prob} reference={{ p: launch, label: `Opened at ${Math.round(launch * 100)}%` }} />
      </div>

      <DataSettled market={market} />

      <div className="pm-stats">
        <Stat
          label="Since launch"
          value={moved === null ? "—" : pts(moved)}
          sub={`Opened at ${Math.round(launch * 100)}%`}
          tone={moved === null || Math.abs(moved) < 0.005 ? undefined : moved > 0 ? "pm-up" : "pm-down"}
        />
        <Stat
          label="Range while you watch"
          value={lo === null || hi === null ? "—" : `${Math.round(lo * 100)}–${Math.round(hi * 100)}%`}
          sub={readings.length ? `${readings.length} live readings` : "Collecting live readings"}
        />
        <Stat
          label="Market agreement"
          value={agreement}
          sub={spread === null ? "Not enough orders" : `Buyers and sellers ${cents(spread)} apart`}
        />
        <Stat label="Money on the line" value={usd(liquidity)} sub="Waiting in the order books" />
        <Stat label="Activity" value={recent === null ? "—" : `${recent} trade${recent === 1 ? "" : "s"}`} sub="In the last hour" />
        <Stat label={left ? "Time left" : "Trading closed"} value={left ?? "Closed"} sub={dateLabel(market.resolution_time)} />
      </div>

      <div className="pm-card pm-explain">
        <h4>How to read this</h4>
        <p>
          The chance comes from live trading. People buy <b className="yes">Yes</b> or <b className="no">No</b> shares that pay $1
          if they turn out to be right, so a Yes price of {v === null ? "62¢" : cents(v)} means the crowd puts the chance at about{" "}
          {v === null ? "62%" : `${Math.round(v * 100)}%`}. When new information arrives, prices move, and so does this number.
        </p>
        <p className="pm-muted pm-small">
          Agreement shows how close buyers and sellers are on price; money on the line shows how much it would take to move
          it. Both make the number more trustworthy.
        </p>
      </div>

      <div className="pm-card">
        <h4>How it resolves</h4>
        <Rules m={market} />
      </div>

      <TradeCta />
    </div>
  );
}
