// "Make it a market": turn a computed table into a YES/NO prediction market settled by its own calculation.
// The api (market_draft) fills defaults and validates on every edit; create_market opens it on the PM backend.
import { useEffect, useRef, useState } from "react";
import { op } from "../api";
import { fmtShort, fmtValue, label, Op, OP_TEXT, Spark } from "../dataMarket";
import "./market.css";

type Val = string | number;
type Check = { level: "ok" | "warn" | "error"; text: string };
type Spec = {
  view_id: string;
  where: Record<string, Val>;
  column: string;
  unit: string | null;
  op: Op;
  threshold: number;
  resolution_time: string;
  initial_price_cents: number;
};
type Draft = {
  ok: boolean;
  view: { id: string; name: string; question: string; intent_id?: string };
  checks: Check[];
  instance?: { id: string; hash: string; formula_hash: string; row_count: number };
  measures?: string[];
  keys?: string[];
  options?: Record<string, Val[]>;
  columns?: { name: string; unit?: string | null; description?: string }[];
  time_column?: string | null;
  next_period?: Val | null;
  spec?: Spec;
  current?: number | null;
  matched?: boolean;
  history?: [Val, number][];
  range?: [number, number] | null;
  suggested?: { threshold: number; chance: number | null; why: string | null };
  question?: string;
  rules?: string;
};
type Form = {
  where: Record<string, Val>;
  column: string;
  op: Op;
  threshold: string;
  resolution_time: string;
  price: number;
  question: string | null; // null = use the generated wording
  rev: number; // > 0 once the user has changed something
};
type Created = { market_id: number; created: boolean; question: string; href: string };

const fromSpec = (s: Spec): Form => ({
  where: s.where,
  column: s.column,
  op: s.op,
  threshold: String(s.threshold),
  resolution_time: s.resolution_time,
  price: s.initial_price_cents,
  question: null,
  rev: 0,
});

/** ISO (UTC) <-> the local value a datetime-local input shows. */
const toLocal = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
/** "£345,000" -> "345000" (currency, thousands separators and spaces are formatting, not part of the number). */
const clean = (s: string) => s.replace(/[£$€,\s_]/g, "");
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const niceRound = (x: number) => {
  if (!x) return 0;
  const step = 10 ** (Math.floor(Math.log10(Math.abs(x))) - 2);
  return Math.round(x / step) * step;
};

export default function MarketDraft(props: {
  viewId: string;
  intentId?: string | null;
  initialWhere?: Record<string, Val>;
  onClose: () => void;
  onCreated?: (c: Created) => void;
}) {
  const [d, setD] = useState<Draft | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [checking, setChecking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const suggestedEnd = useRef<string | null>(null);
  const seq = useRef(0);

  const args = (f: Form) => ({
    view_id: props.viewId,
    where: f.where,
    column: f.column,
    op: f.op,
    threshold: f.threshold.trim() === "" ? null : clean(f.threshold), // garbage goes through: the api says it's not a number
    resolution_time: f.resolution_time,
    initial_price_cents: f.price,
    question: f.question,
  });

  useEffect(() => {
    op<Draft>("market_draft", { view_id: props.viewId, where: props.initialWhere })
      .then((x) => {
        setD(x);
        suggestedEnd.current = x.spec?.resolution_time ?? null;
        if (x.spec) setForm(fromSpec(x.spec));
      })
      .catch((e) => setErr(e.message));
  }, [props.viewId]);

  // re-check after every edit (debounced); only the latest answer counts. A cleared line (new row or column) is
  // filled with the line the api suggests for it.
  const formRef = useRef(form);
  formRef.current = form;
  useEffect(() => {
    const f = formRef.current;
    if (!f || f.rev === 0) return;
    const my = ++seq.current;
    setChecking(true);
    const h = setTimeout(() => {
      op<Draft>("market_draft", args(f))
        .then((x) => {
          if (my !== seq.current) return;
          setD(x);
          setErr(null);
          if (x.spec && formRef.current?.threshold.trim() === "") setForm((ff) => ff && { ...ff, threshold: String(x.spec!.threshold) });
        })
        .catch((e) => my === seq.current && setErr(e.message))
        .finally(() => my === seq.current && setChecking(false));
    }, 300);
    return () => clearTimeout(h);
  }, [form?.rev]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !creating && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [creating, props.onClose]);

  const edit = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch, rev: f.rev + 1 } : f));
  const create = async () => {
    if (!form) return;
    setCreating(true);
    setErr(null);
    try {
      const c = await op<Created>("create_market", { ...args(form), intent_id: props.intentId ?? undefined });
      setCreated(c);
      props.onCreated?.(c);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const unit = d?.spec?.unit ?? null;
  const line = form && form.threshold.trim() !== "" ? Number(clean(form.threshold)) : NaN;
  const tc = d?.time_column ?? null;
  const base = d?.current ?? d?.history?.[d.history.length - 1]?.[1] ?? d?.suggested?.threshold ?? null;
  const sym = { gbp: "£", usd: "$", eur: "€" }[(unit || "").toLowerCase()];
  const lastHist = d?.history?.length ? d.history[d.history.length - 1] : null;

  return (
    <div className="mk-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !creating && props.onClose()}>
      <div className="mk-modal" role="dialog" aria-modal="true" aria-label="Make it a prediction market">
        <div className="mk-head">
          <div>
            <h3>{created ? "Market is open" : "Make it a prediction market"}</h3>
            <div className="muted small">
              {d ? (
                <>
                  settled by <b>{d.view.name}</b>
                  {d.instance?.hash && (
                    <>
                      {" "}· fingerprint <code>{d.instance.hash.slice(0, 10)}…</code>
                    </>
                  )}
                </>
              ) : (
                "checking the table…"
              )}
            </div>
          </div>
          <button className="mk-x" onClick={props.onClose} disabled={creating} aria-label="Close">
            ×
          </button>
        </div>

        {created ? (
          <div className="mk-body mk-done">
            <div className="mk-done-mark">✓</div>
            <p className="mk-done-title">{created.created ? `Market #${created.market_id} is open` : `This market already exists (#${created.market_id})`}</p>
            <p className="mk-done-q">“{created.question}”</p>
            <p className="muted small">
              It settles by itself at the end date: the same calculation runs on the data published by then, and the answer is
              posted with its fingerprint.
            </p>
            <div className="mk-foot">
              <button onClick={props.onClose}>Close</button>
              <a className="mk-primary" href={created.href}>
                Open market →
              </a>
            </div>
          </div>
        ) : !d || !form ? (
          <div className="mk-body">
            {err ? (
              <div className="error">{err}</div>
            ) : d && !d.spec ? (
              <Checks checks={d.checks} />
            ) : (
              <div className="muted">Checking the calculation…</div>
            )}
          </div>
        ) : (
          <>
            <div className="mk-body">
              <section>
                <div className="mk-label">Question</div>
                <textarea
                  className="mk-question"
                  rows={2}
                  value={form.question ?? d.question ?? ""}
                  onChange={(e) => edit({ question: e.target.value })}
                />
                {form.question !== null && (
                  <button className="mk-link" onClick={() => edit({ question: null })}>
                    ↺ use the generated wording
                  </button>
                )}
              </section>

              <section>
                <div className="mk-label">The number</div>
                <div className="mk-row">
                  <select value={form.column} onChange={(e) => edit({ column: e.target.value, threshold: "" })}>
                    {(d.measures ?? []).map((m) => (
                      <option key={m} value={m}>
                        {label(m)}
                      </option>
                    ))}
                  </select>
                  {(d.keys ?? []).length > 0 && <span className="muted">for</span>}
                  {(d.keys ?? []).map((k) => {
                    const opts = d.options?.[k] ?? [];
                    const cur = form.where[k];
                    const idx = cur === undefined ? -1 : opts.findIndex((o) => String(o) === String(cur));
                    return (
                      <label key={k} className="mk-key">
                        <span className="muted small">{label(k)}</span>
                        <select
                          value={idx}
                          onChange={(e) => {
                            const i = Number(e.target.value);
                            const where = { ...form.where };
                            if (i < 0) delete where[k];
                            else where[k] = opts[i];
                            edit({ where, threshold: "" });
                          }}
                        >
                          <option value={-1}>any</option>
                          {opts.map((o, i) => (
                            <option key={String(o)} value={i}>
                              {String(o)}
                              {k === tc && String(o) === String(d.next_period) ? "  (next, no data yet)" : ""}
                            </option>
                          ))}
                        </select>
                      </label>
                    );
                  })}
                </div>
                <div className="mk-now small">
                  {d.matched ? (
                    <>
                      Today: <b>{fmtValue(d.current, unit)}</b>
                    </>
                  ) : lastHist ? (
                    <>
                      No data for {tc ? String(form.where[tc]) : "this row"} yet · latest {String(lastHist[0])}:{" "}
                      <b>{fmtValue(lastHist[1], unit)}</b>
                    </>
                  ) : (
                    "No data for this row yet"
                  )}
                </div>
                {(d.history?.length ?? 0) >= 2 && Number.isFinite(line) && (
                  <Spark
                    history={d.history!}
                    line={line}
                    unit={unit}
                    target={tc ? form.where[tc] : null}
                    yes={form.op.startsWith(">") ? "above" : "below"}
                  />
                )}
              </section>

              <section>
                <div className="mk-label">Resolves YES if it is</div>
                <div className="mk-row">
                  <div className="mk-seg" role="radiogroup">
                    {(Object.keys(OP_TEXT) as Op[]).map((o) => (
                      <button key={o} role="radio" aria-checked={form.op === o} className={form.op === o ? "on" : ""} onClick={() => edit({ op: o })}>
                        {OP_TEXT[o]}
                      </button>
                    ))}
                  </div>
                  <div className="mk-num">
                    {sym && <span>{sym}</span>}
                    <input
                      inputMode="decimal"
                      value={form.threshold}
                      onChange={(e) => edit({ threshold: e.target.value })}
                      aria-label="line"
                    />
                    {unit && !sym && <span className="muted small">{unit}</span>}
                  </div>
                </div>
                {d.range && (
                  <input
                    className="mk-slider"
                    type="range"
                    min={niceRound(d.range[0] - (d.range[1] - d.range[0] || Math.abs(d.range[0]) || 1) * 0.5)}
                    max={niceRound(d.range[1] + (d.range[1] - d.range[0] || Math.abs(d.range[1]) || 1) * 0.5)}
                    step={Math.max(niceRound((d.range[1] - d.range[0] || Math.abs(d.range[1]) || 1) / 100) || 0.01, 0.0001)}
                    value={Number.isFinite(line) ? line : 0}
                    onChange={(e) => edit({ threshold: e.target.value })}
                  />
                )}
                {base !== null && (
                  <div className="mk-chips">
                    {[-0.1, -0.05, 0, 0.05, 0.1].map((k) => {
                      const v = niceRound(base * (1 + k));
                      return (
                        <button key={k} className={Number(form.threshold) === v ? "on" : ""} onClick={() => edit({ threshold: String(v) })}>
                          {k === 0 ? `= ${fmtShort(v, unit)}` : `${k > 0 ? "+" : "−"}${Math.abs(k * 100)}%`}
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>

              <div className="mk-two">
                <section>
                  <div className="mk-label">Settles at</div>
                  <input
                    type="datetime-local"
                    value={toLocal(form.resolution_time)}
                    onChange={(e) => e.target.value && edit({ resolution_time: new Date(e.target.value).toISOString() })}
                  />
                  <div className="mk-chips">
                    <button onClick={() => edit({ resolution_time: inMinutes(10) })}>10 min</button>
                    <button onClick={() => edit({ resolution_time: inMinutes(60 * 24) })}>1 day</button>
                    <button onClick={() => edit({ resolution_time: inMinutes(60 * 24 * 7) })}>1 week</button>
                    {suggestedEnd.current && (
                      <button
                        className={form.resolution_time === suggestedEnd.current ? "on" : ""}
                        title="Usually enough time for the data to be published"
                        onClick={() => edit({ resolution_time: suggestedEnd.current! })}
                      >
                        {new Date(suggestedEnd.current).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
                      </button>
                    )}
                  </div>
                </section>
                <section>
                  <div className="mk-label">Starting chance of YES</div>
                  <div className="mk-row">
                    <input type="range" min={2} max={98} value={form.price} onChange={(e) => edit({ price: Number(e.target.value) })} />
                    <b className="mk-pct">{form.price}%</b>
                  </div>
                  {d.suggested?.chance != null && (
                    <div className="muted small">
                      Suggested {d.suggested.chance}%{" "}
                      {form.price !== d.suggested.chance && (
                        <button className="mk-link" onClick={() => edit({ price: d.suggested!.chance! })}>
                          use
                        </button>
                      )}
                      <div>{d.suggested.why}</div>
                    </div>
                  )}
                </section>
              </div>

              <section>
                <div className="mk-label">
                  Checks {checking && <span className="mk-spin" aria-label="checking" />}
                </div>
                <Checks checks={d.checks} />
              </section>

              {d.rules && (
                <details className="mk-rules">
                  <summary>Rules traders will see</summary>
                  <p>{d.rules}</p>
                </details>
              )}
              {err && <div className="error small">{err}</div>}
            </div>
            <div className="mk-foot">
              <span className="muted small grow">
                {d.ok ? `${label(form.column)} ${OP_TEXT[form.op]} ${fmtValue(line, unit)} → YES` : "Fix the red checks to continue"}
              </span>
              <button onClick={props.onClose} disabled={creating}>
                Cancel
              </button>
              <button className="mk-primary" disabled={!d.ok || checking || creating} onClick={create}>
                {creating ? "Opening the market…" : "Create market"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Checks({ checks }: { checks: Check[] }) {
  return (
    <ul className="mk-checks">
      {checks.map((c, i) => (
        <li key={i} className={c.level}>
          <span className="mk-ico">{c.level === "ok" ? "✓" : c.level === "warn" ? "!" : "✕"}</span>
          {c.text}
        </li>
      ))}
    </ul>
  );
}
