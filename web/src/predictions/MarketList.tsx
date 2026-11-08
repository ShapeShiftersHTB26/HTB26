import { useMemo, useState } from "react";
import type { MarketInfo } from "./api";
import { isDataSettled } from "./DataSettled";
import CreateMarket from "./CreateMarket";
import { Quote, useMarkets } from "./hooks";
import { InsightCard } from "./Insights";
import { useMode } from "./mode";
import { Gauge, Modal, Skeleton, Spinner } from "./ui";
import { cents, countdown, dateLabel, marketHref, Outcome, phase, Phase } from "./util";

type Filter = "all" | "open" | "awaiting" | "resolved";
const FILTERS: [Filter, string][] = [
  ["all", "All"],
  ["open", "Open"],
  ["awaiting", "Awaiting result"],
  ["resolved", "Resolved"],
];
const ORDER: Record<Phase, number> = { open: 0, pending: 1, awaiting: 2, resolved: 3, failed: 4 };
const matches = (f: Filter, p: Phase) => f === "all" || p === f || (f === "open" && p === "pending");

export default function MarketList() {
  const { mode } = useMode();
  const insights = mode === "insights";
  const { markets, quotes, err, refresh } = useMarkets();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);

  const shown = useMemo(() => (markets ?? []).filter((m) => phase(m) !== "failed"), [markets]);
  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map(([f]) => [f, shown.filter((m) => matches(f, phase(m))).length])) as Record<Filter, number>,
    [shown],
  );
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return shown
      .filter((m) => matches(filter, phase(m)) && (!q || m.question.toLowerCase().includes(q)))
      .sort((a, b) => {
        const pa = phase(a);
        const pb = phase(b);
        if (pa !== pb) return ORDER[pa] - ORDER[pb];
        // open markets: closing soonest first; the rest: newest first
        return pa === "open" ? +new Date(a.resolution_time) - +new Date(b.resolution_time) : b.id - a.id;
      });
  }, [shown, filter, query]);

  return (
    <div className="pm-list">
      <div className="pm-hero">
        {insights ? (
          <div>
            <h1>What's likely to happen?</h1>
            <p className="pm-sub">Live odds on real-world questions, set by people putting money on the outcome.</p>
          </div>
        ) : (
          <div>
            <h1>Markets</h1>
            <p className="pm-sub">Trade on how real-world questions resolve. Prices are probabilities: 63¢ means a 63% chance.</p>
          </div>
        )}
        <button className={`pm-btn pm-btn-lg ${insights ? "pm-btn-soft" : "pm-btn-primary"}`} onClick={() => setCreating(true)}>
          {insights ? "+ Ask a question" : "+ Create market"}
        </button>
      </div>

      <div className="pm-toolbar">
        <div className="pm-tabs" role="tablist">
          {FILTERS.map(([f, label]) => (
            <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
              {label}
              {markets && <span className="pm-count">{counts[f]}</span>}
            </button>
          ))}
        </div>
        <label className="pm-search">
          <svg viewBox="0 0 20 20" aria-hidden>
            <circle cx="9" cy="9" r="6" />
            <path d="M14 14l4 4" />
          </svg>
          <input placeholder="Search markets" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </div>

      {err && <div className="pm-banner err">Couldn't load markets: {err}</div>}

      <div className="pm-grid">
        {!markets &&
          Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="pm-mcard">
              <div className="pm-mcard-top">
                <div style={{ flex: 1 }}>
                  <Skeleton h={18} />
                  <div style={{ height: 8 }} />
                  <Skeleton h={18} w="60%" />
                </div>
                <Skeleton h={46} w={58} />
              </div>
              <Skeleton h={38} />
            </div>
          ))}
        {visible.map((m) =>
          insights ? <InsightCard key={m.id} m={m} prob={quotes[m.id]?.prob ?? null} /> : <MarketCard key={m.id} m={m} quote={quotes[m.id]} />,
        )}
      </div>

      {markets && !visible.length && (
        <div className="pm-empty">
          {query ? (
            <>No markets match “{query}”.</>
          ) : (
            <>
              Nothing here yet.{" "}
              <button className="pm-link" onClick={() => setCreating(true)}>
                Create the first market
              </button>
            </>
          )}
        </div>
      )}

      {creating && (
        <Modal title={insights ? "Ask a question" : "Create a market"} onClose={() => setCreating(false)}>
          <CreateMarket
            onCreated={(id) => {
              setCreating(false);
              refresh();
              window.location.hash = marketHref(id);
            }}
          />
        </Modal>
      )}
    </div>
  );
}

function MarketCard({ m, quote }: { m: MarketInfo; quote?: Quote }) {
  const p = phase(m);
  const go = (buy?: Outcome) => (window.location.hash = marketHref(m.id, buy));
  return (
    <div
      className={`pm-mcard ${p}`}
      role="link"
      tabIndex={0}
      onClick={() => go()}
      onKeyDown={(e) => e.key === "Enter" && go()}
    >
      <div className="pm-mcard-top">
        <h3>
          <a href={marketHref(m.id)} onClick={(e) => e.stopPropagation()}>
            {m.question}
          </a>
        </h3>
        {(p === "open" || p === "awaiting") && <Gauge p={quote?.prob ?? null} />}
        {p === "resolved" && <span className={`pm-outcome ${m.outcome}`}>{m.outcome === "void" ? "Void" : m.outcome === "yes" ? "Yes" : "No"}</span>}
      </div>

      {p === "open" && (
        <div className="pm-mcard-actions">
          {(["yes", "no"] as const).map((o) => (
            <button
              key={o}
              className={`pm-buy ${o}`}
              onClick={(e) => {
                e.stopPropagation();
                go(o);
              }}
            >
              Buy {o === "yes" ? "Yes" : "No"}
              <span>{quote?.[o] != null ? cents(quote[o]!) : ""}</span>
            </button>
          ))}
        </div>
      )}
      {p === "pending" && (
        <div className="pm-mcard-note">
          <Spinner /> Seeding liquidity…
        </div>
      )}
      {p === "awaiting" && <div className="pm-mcard-note">Trading closed · waiting for the result</div>}
      {p === "resolved" && <div className="pm-mcard-note">Resolved · winners can redeem on the market page</div>}

      <div className="pm-mcard-foot">
        <span>
          {p === "open" || p === "pending"
            ? `Closes in ${countdown(m.resolution_time) ?? "a moment"}`
            : p === "resolved" && m.resolved_at
              ? `Resolved ${dateLabel(m.resolved_at)}`
              : `Closed ${dateLabel(m.resolution_time)}`}
        </span>
        <span>
          {isDataSettled(m) && <span className="pm-data-badge" title="Settles automatically from a Backtrace calculation">by data</span>}#{m.id}
        </span>
      </div>
    </div>
  );
}
