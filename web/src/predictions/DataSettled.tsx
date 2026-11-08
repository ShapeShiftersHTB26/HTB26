// Markets made from a Backtrace table settle by data: this card shows the rule, what today's data says, and once
// settled, the evidence (value, fingerprint, files). Shared by both views.
import { useEffect, useState } from "react";
import { fmtValue, OP_TEXT, ruleText, Spark } from "../dataMarket";
import { DataRule, DataStatus, dataApi, MarketInfo } from "./api";
import { useToast } from "./ui";
import { dateLabel, phase } from "./util";

export const isDataSettled = (m: MarketInfo): m is MarketInfo & { resolution: DataRule } => m.resolution?.source === "backtrace";

const STATUS_POLL_MS = 30_000;

function useDataStatus(m: MarketInfo, live: boolean): DataStatus | null {
  const [s, setS] = useState<DataStatus | null>(null);
  useEffect(() => {
    if (!live) return;
    let alive = true;
    const run = () => dataApi.status(m.id).then((x) => alive && setS(x)).catch((e) => alive && setS({ market_id: m.id, status: m.status, error: e.message }));
    run();
    const h = setInterval(run, STATUS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [m.id, live]);
  return s;
}

export default function DataSettled({ market }: { market: MarketInfo }) {
  const toast = useToast();
  const p = phase(market);
  const live = p === "open" || p === "awaiting";
  const s = useDataStatus(market, live && isDataSettled(market));
  const [settling, setSettling] = useState(false);
  if (!isDataSettled(market)) return null;
  const r = market.resolution;
  const st = r.settlement;
  const tc = s?.time_column ?? null;
  const settle = async () => {
    setSettling(true);
    try {
      const x = await dataApi.settle(market.id);
      toast({ kind: "ok", title: `Settled ${x.outcome.toUpperCase()} from data`, detail: "Re-ran the pinned calculation and posted the result" });
    } catch (e) {
      toast({ kind: "err", title: "Couldn't settle yet", detail: (e as Error).message });
    } finally {
      setSettling(false);
    }
  };
  const files = (st?.data ?? s?.data ?? []).flatMap((d) => d.files);
  const hash = st?.hash ?? s?.instance?.hash ?? r.created_from.hash;

  return (
    <div className="pm-card pm-data">
      <div className="pm-data-top">
        <span className="pm-kicker">Settled by data</span>
        <span className="pm-data-chip" title="Every step is a fixed calculation: re-running it gives the same answer">deterministic</span>
      </div>
      <p className="pm-data-rule">
        <b className="yes">Yes</b> if {ruleText(r)}.
      </p>

      {st ? (
        <div className={`pm-data-result ${market.outcome}`}>
          <b>{market.outcome === "void" ? "Void" : market.outcome === "yes" ? "Settled Yes" : "Settled No"}</b>
          <span>{st.reason}</span>
        </div>
      ) : live && s && !s.error && s.would_settle ? (
        <div className={`pm-data-now ${s.would_settle}`}>
          <span className="pm-muted">Today's data</span>
          <b>{s.value === null || s.value === undefined ? "no row yet" : fmtValue(s.value, r.unit)}</b>
          <span className={`pm-data-would ${s.would_settle}`}>
            {s.would_settle === "void" ? "would be void" : `would settle ${s.would_settle === "yes" ? "Yes" : "No"}`}
          </span>
        </div>
      ) : live && s?.error ? (
        <div className="pm-muted pm-small">Couldn't read today's data: {s.error}</div>
      ) : null}

      {live && (s?.history?.length ?? 0) >= 2 && (
        <Spark history={s!.history!} line={r.threshold} unit={r.unit} target={tc ? r.where[tc] : null} yes={r.op.startsWith(">") ? "above" : "below"} />
      )}

      {p === "awaiting" && !st && (
        <div className="pm-data-settle">
          <span className="pm-muted pm-small">The end date has passed: it settles by itself within a minute, or now.</span>
          <button className="pm-btn pm-btn-primary" disabled={settling} onClick={settle}>
            {settling ? "Settling…" : "Settle from data"}
          </button>
        </div>
      )}

      <div className="pm-kvs">
        <div className="pm-kv">
          <span>Table</span>
          <span>{r.view_name}</span>
        </div>
        <div className="pm-kv">
          <span>Line</span>
          <span>
            {OP_TEXT[r.op]} {fmtValue(r.threshold, r.unit)}
          </span>
        </div>
        {files.length > 0 && (
          <div className="pm-kv">
            <span>Data</span>
            <span>{[...new Set(files)].join(", ")}</span>
          </div>
        )}
        <div className="pm-kv">
          <span>{st ? "Settled on" : "Fingerprint"}</span>
          <span title={hash}>
            <code>{hash.slice(0, 12)}…</code>
            {st?.verified && <span className="pm-data-ok"> ✓ re-run and verified</span>}
          </span>
        </div>
        {st && (
          <div className="pm-kv">
            <span>Settled</span>
            <span>{dateLabel(st.settled_at)}</span>
          </div>
        )}
      </div>
      {r.intent_id && (
        <a className="pm-data-link" href={`#/t/${r.intent_id}`}>
          See the research behind it →
        </a>
      )}
    </div>
  );
}
