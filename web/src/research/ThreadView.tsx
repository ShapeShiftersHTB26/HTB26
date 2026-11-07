import { useCallback, useEffect, useRef, useState } from "react";
import { Column, columns, Dataset, op, Thread, ThreadItem, ViewDetail } from "../api";
import { Card, CardAction } from "../ProposalCards";
import RowsTable from "../RowsTable";
import ShapeBody from "../ShapeBody";
import TransformBody from "../TransformBody";
import VerifyReport from "../VerifyReport";
import { Rail } from "./Landing";

type Send = (text: string, kind?: "chat" | "action") => Promise<void>;
type Ctx = { t: Thread; send: Send; reload: () => void; onOpenVisual: (visualId: string, viewId: string) => void; onTrace: (rid: string) => void };
const LABEL = { schema: "Shape", transform: "Transform", visual: "Visual" } as const;

/** One research thread: the chat with the agent, its proposals as cards, data cards and answers, in order. */
export default function ThreadView(props: { id: string; onOpenVisual: Ctx["onOpenVisual"]; onTrace: Ctx["onTrace"] }) {
  const [t, setT] = useState<Thread | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [queuedSince, setQueuedSince] = useState<number | null>(null);
  const end = useRef<HTMLDivElement>(null);

  const load = useCallback(
    () =>
      op<Thread>("get_thread", { intent_id: props.id })
        .then((x) => (setT(x), setErr(null)))
        .catch((e) => setErr(e.message)),
    [props.id],
  );
  useEffect(() => {
    load();
    const h = setInterval(load, 1500);
    return () => clearInterval(h);
  }, [load]);

  const status = t?.intent.agent_status ?? "idle";
  useEffect(() => setQueuedSince((s) => (status === "queued" ? s ?? Date.now() : null)), [status]);
  useEffect(() => end.current?.scrollIntoView({ behavior: "smooth", block: "end" }), [t?.items.length, status]);

  const send: Send = async (text, kind = "chat") => {
    await op("ask", { text, intent_id: props.id, kind });
    load();
  };

  if (err && !t) return <div className="error pad">{err}</div>;
  if (!t) return <div className="muted pad">loading…</div>;
  const ctx: Ctx = { t, send, reload: load, onOpenVisual: props.onOpenVisual, onTrace: props.onTrace };
  const busy = status === "queued" || status === "working";
  const stalled = status === "queued" && queuedSince !== null && Date.now() - queuedSince > 10_000;

  return (
    <div className="thread">
      <div className="thread-head">
        <Rail stage={t.stage} future={t.stage === "explore"} />
      </div>
      <div className="feed">
        {t.items.map((it, i) => (
          <Item key={(it as any).id || (it.type === "proposal" ? it.proposal.id : `${it.type}-${i}`)} it={it} ctx={ctx} />
        ))}
        {busy && (
          <div className="msg agent">
            <div className="bubble typing">
              <span className="dots"><i /><i /><i /></span> {status === "queued" ? "Reading your message…" : "Working on it…"}
            </div>
            {stalled && <div className="muted small">No agent has picked this up. Is the runner running? <code>python scripts/runner.py</code></div>}
          </div>
        )}
        {status === "error" && (
          <div className="msg agent">
            <div className="bubble error-bubble">
              Something went wrong: {t.intent.agent_error}{" "}
              <button onClick={() => send("Please try that again.", "action")}>Retry</button>
            </div>
          </div>
        )}
        <div ref={end} />
      </div>
      <Composer onSend={send} />
    </div>
  );
}

function Item({ it, ctx }: { it: ThreadItem; ctx: Ctx }) {
  if (it.type === "proposal") return <ProposalItem it={it} ctx={ctx} />;
  if (it.type === "result") return <ResultCard it={it} ctx={ctx} />;
  if (it.kind === "action") return <div className="msg action">{it.text}</div>;
  if (it.role === "user") return <div className="msg user"><div className="bubble">{it.text}</div></div>;
  return (
    <div className="msg agent">
      <div className="bubble">{it.text}</div>
      {it.kind === "datasets" && (
        <div className="datasets">
          {(it.datasets || []).map((id) => {
            const d = ctx.t.datasets[id];
            return d ? <DatasetCard key={id} d={d} onUse={() => ctx.send(`Use dataset ${id} (${d.title}).`, "action")} /> : null;
          })}
        </div>
      )}
      {it.kind === "source" && it.view_id && <SourceCard viewId={it.view_id} hash={it.hash} ctx={ctx} />}
      {!!it.suggestions?.length && (
        <div className="suggestions">
          {it.suggestions.map((s) => (
            <button key={s} onClick={() => ctx.send(s)}>{s}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function ProposalItem({ it, ctx }: { it: Extract<ThreadItem, { type: "proposal" }>; ctx: Ctx }) {
  const p = it.proposal;
  const [open, setOpen] = useState(false);
  const label = LABEL[it.kind];
  const title = (
    <>
      <span className={`kind ${it.kind === "transform" ? p.kind : ""}`}>
        {label}
        {it.kind === "transform" && p.kind ? ` · ${p.kind}` : ""}
      </span>{" "}
      <b>{it.view_name}</b>
    </>
  );
  const stale = p.status === "discarded" || (p.status === "approved" && !it.is_head);
  if (stale && !open)
    return (
      <div className="msg action clickable" onClick={() => setOpen(true)} title="show">
        {title} · {p.status === "discarded" ? "discarded" : "superseded"}
      </div>
    );
  const body =
    it.kind === "schema" ? (
      <ShapeBody p={p} />
    ) : it.kind === "transform" ? (
      <TransformBody p={p} names={new Map(Object.entries(ctx.t.names))} />
    ) : (
      <button onClick={() => ctx.onOpenVisual(p.id, p.view_id)}>◧ Open visual</button>
    );
  const onAction = (a: CardAction, text?: string) =>
    ctx.send(
      a === "comment"
        ? `Comment on the ${label.toLowerCase()} of ${it.view_name}: ${text}`
        : `${a === "approve" ? "Approved" : "Discarded"} the ${label.toLowerCase()} of ${it.view_name}.`,
      "action",
    );
  return (
    <div className="item">
      <div className="item-title">{title}</div>
      <Card p={p} isHead={it.is_head} comments={ctx.t.comments[p.id] || []} body={body} onChange={ctx.reload} onAction={onAction} />
    </div>
  );
}

function DatasetCard({ d, onUse }: { d: Dataset; onUse: () => void }) {
  return (
    <div className={`dataset ${d.available ? "" : "unavailable"}`}>
      <div className="ds-title">{d.title}</div>
      <div className="muted small">
        {d.publisher} · {d.licence}
      </div>
      <div className="ds-desc">{d.description}</div>
      <div className="chips">
        <span className="chip">{d.coverage}</span>
        <span className="chip">updated {d.updated}</span>
        <span className="chip">{d.size}</span>
      </div>
      {d.loaded_as.length > 0 && <div className="muted small">Already loaded: {d.loaded_as.map((v) => v.name).join(", ")}</div>}
      <div className="card-actions">
        {d.available ? <button className="approve" onClick={onUse}>Use this</button> : <span className="muted small">Not downloaded yet</span>}
        <a href={d.url} target="_blank" rel="noreferrer" className="small">
          about the data ↗
        </a>
      </div>
    </div>
  );
}

function SourceCard({ viewId, hash, ctx }: { viewId: string; hash?: string; ctx: Ctx }) {
  const [rows, setRows] = useState<Record<string, any>[] | null>(null);
  const peek = () =>
    rows ? setRows(null) : op("get_records", { view_id: viewId, limit: 8 }).then((r) => setRows(r.rows));
  return (
    <div className="source-card">
      <span className="vb data">✓ loaded</span>
      {hash && <code className="hash" title={hash}>{hash.slice(0, 12)}…</code>}
      <button onClick={peek}>{rows ? "Hide rows" : "Peek at rows"}</button>
      {rows && <RowsTable cols={[]} rows={rows} onSelect={ctx.onTrace} />}
    </div>
  );
}

function nextPeriod(cols: Column[], rows: Record<string, any>[]) {
  const tc = cols.find((c) => c.role === "time") || cols.find((c) => /^(year|period)$/i.test(c.name));
  if (!tc) return null;
  const years = rows.map((r) => Number(r[tc.name])).filter((v) => Number.isInteger(v) && v > 1900 && v < 2200);
  if (!years.length) return null;
  const last = Math.max(...years);
  return { col: tc.name, last, next: last + 1, measures: cols.filter((c) => c.role === "measure").map((c) => c.name) };
}

function ResultCard({ it, ctx }: { it: Extract<ThreadItem, { type: "result" }>; ctx: Ctx }) {
  const [data, setData] = useState<{ cols: Column[]; rows: Record<string, any>[] } | null>(null);
  const [others, setOthers] = useState(false);
  useEffect(() => {
    if (!it.instance) return;
    Promise.all([
      op<ViewDetail>("get_view", { view_id: it.view_id }),
      op("get_records", { instance_id: it.instance.id, limit: 500 }),
    ]).then(([d, r]) => {
      const ss = d.proposals.schema;
      const shape = ss.find((s) => s.id === d.head.schema) || ss[ss.length - 1];
      setData({ cols: columns(shape?.schema), rows: r.rows });
    });
  }, [it.instance?.id]);
  const isEstimate = /estimate|projection|forecast/i.test(it.view_name || "");
  const future = data && !isEstimate ? nextPeriod(data.cols, data.rows) : null;
  return (
    <div className="item">
      <div className="item-title">
        <span className="kind answer-kind">Answer</span> <b>{it.view_name}</b>
      </div>
      <div className="result-card">
        {it.summary && <div className="answer">{it.summary}</div>}
        {it.result_kind === "visual" && it.result_current && (
          <button className="approve" onClick={() => ctx.onOpenVisual(it.result_current!, it.view_id)}>◧ Open visual</button>
        )}
        {it.instance ? (
          data ? (
            <>
              <RowsTable cols={data.cols} rows={data.rows} onSelect={ctx.onTrace} max={50} />
              <div className="muted small">Click any row to see the records it came from.</div>
            </>
          ) : (
            <div className="muted small">loading rows…</div>
          )
        ) : (
          <div className="muted small">not evaluated yet</div>
        )}
        {future && (
          <div className="future">
            <div className="future-row">
              <span className="label">{future.col}</span> <b>{future.next}</b>
              {future.measures.map((m) => (
                <span key={m} className="cell">
                  {m} <b>?</b>
                </span>
              ))}
            </div>
            <div className="muted small">
              The data stops at {future.last}. This row will be filled when {future.next} data is published, using exactly the
              same calculation as the rows above.
            </div>
            <div className="card-actions">
              <button onClick={() => ctx.send(`Estimate ${future.col} ${future.next} from historicals for ${it.view_name}.`)}>
                Estimate from historicals
              </button>
              <button onClick={() => setOthers(true)}>Ask others</button>
            </div>
            {others && (
              <div className="note">
                Coming next: open a prediction market on this cell. People trade on what {future.next} will show, and it settles
                from this exact calculation once the data lands.
              </div>
            )}
          </div>
        )}
        {it.instance && (
          <VerifyReport key={it.instance.id} instanceId={it.instance.id} hash={it.instance.hash}
                        label="fingerprint: changes if any underlying row changes" />
        )}
      </div>
    </div>
  );
}

function Composer({ onSend }: { onSend: Send }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="composer"
      onSubmit={async (e) => {
        e.preventDefault();
        const x = text.trim();
        if (!x) return;
        setBusy(true);
        try {
          await onSend(x);
          setText("");
        } finally {
          setBusy(false);
        }
      }}
    >
      <input value={text} onChange={(e) => setText(e.target.value)} disabled={busy}
             placeholder="Reply, ask a follow-up, or say what to change…" />
      <button className="approve" disabled={busy || !text.trim()}>Send</button>
    </form>
  );
}
