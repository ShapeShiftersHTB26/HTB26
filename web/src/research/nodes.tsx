import { Handle, NodeProps, Position } from "@xyflow/react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Column, columns, Dataset, op, Proposal } from "../api";
import VerifyReport from "../VerifyReport";
import { useThread } from "./ctx";
import MarketDraft from "./MarketDraft";

export type CanvasView = {
  id: string;
  name: string;
  kind: "source" | "derived";
  member: boolean;
  head_schema: Proposal | null;
  pending_schemas: Proposal[];
  head_transform: { id: string; kind: string; reads: string[]; rationale?: string } | null;
  pending_transforms: { id: string; kind: string; reads: string[]; rationale?: string; warnings?: string[] }[];
  visuals: { id: string; status: string; rationale?: string }[];
  answer?: string | null;
  instance: { id: string; hash?: string; row_count?: number } | null;
};
export type Note = { id: string; text: string; about?: string; author: string; created_at: string };

const Handles = () => (
  <>
    <Handle type="target" position={Position.Top} />
    <Handle type="source" position={Position.Bottom} />
  </>
);

function useAct() {
  const { send, reload } = useThread();
  const [busy, setBusy] = useState(false);
  const act = async (id: string, decision: "approve" | "discard", msg: string) => {
    setBusy(true);
    try {
      await op("decide", { target_id: id, decision });
      await send(msg, "action");
    } finally {
      setBusy(false);
      reload();
    }
  };
  return { busy, act };
}

// ------------------------------------------------------------------------------------------- question / notes

export function QuestionNode({ data }: NodeProps) {
  return (
    <div className="rnode question">
      <div className="label">research question</div>
      <div className="q">“{data.text as string}”</div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

export function NoteNode({ data }: NodeProps) {
  const n = data.note as Note;
  return (
    <div className={`rnode note by-${n.author}`}>
      <Handle type="target" position={Position.Top} />
      <div className="note-text">{n.text}</div>
      <div className="muted small">{n.author === "user" ? "your note" : "agent note"}</div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

// ------------------------------------------------------------------------------------------- table node

type DiffCol = Column & { st: "same" | "added" | "removed" | "changed" | "new" };

function diffColumns(head: Proposal | null, pend: Proposal | null): DiffCol[] {
  const h = columns(head?.schema);
  if (!pend) return h.map((c) => ({ ...c, st: "same" }));
  const p = columns(pend.schema);
  if (!head) return p.map((c) => ({ ...c, st: "new" }));
  // the proposal's column order, with removed columns kept at their old position
  const hm = new Map(h.map((c) => [c.name, c]));
  const out: DiffCol[] = p.map((q) => {
    const c = hm.get(q.name);
    if (!c) return { ...q, st: "added" };
    const changed = q.type !== c.type || q.unit !== c.unit || q.role !== c.role;
    return { ...q, st: changed ? "changed" : "same" };
  });
  const pn = new Set(p.map((c) => c.name));
  h.forEach((c, i) => !pn.has(c.name) && out.splice(Math.min(i, out.length), 0, { ...c, st: "removed" }));
  return out;
}

function diffList(a: string[] = [], b: string[] = []) {
  return [
    ...a.map((x) => ({ x, st: b.includes(x) ? "same" : "removed" })),
    ...b.filter((x) => !a.includes(x)).map((x) => ({ x, st: "added" })),
  ];
}

function nextPeriod(cols: Column[], rows: Record<string, any>[]) {
  const tc = cols.find((c) => c.role === "time") || cols.find((c) => /^(year|period)$/i.test(c.name));
  if (!tc) return null;
  const years = rows.map((r) => Number(r[tc.name])).filter((v) => Number.isInteger(v) && v > 1900 && v < 2200);
  if (!years.length) return null;
  const last = Math.max(...years);
  return { col: tc.name, last, next: last + 1 };
}

function fmt(v: any, c?: Column) {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "number" && c && (c.role === "time" || /year/i.test(c.name))) return String(v);
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function TableNode({ data }: NodeProps) {
  const v = data.view as CanvasView;
  const { t, send, reload, focus, onOpenVisual, onTrace } = useThread();
  const { busy, act } = useAct();
  const [rows, setRows] = useState<Record<string, any>[] | null>(null);
  const [market, setMarket] = useState(false);
  const iid = v.instance?.id;
  useEffect(() => {
    if (!iid) return setRows(null);
    op("get_records", { instance_id: iid, limit: 6 }).then((r) => setRows(r.rows)).catch(() => setRows([]));
  }, [iid]);

  const head = v.head_schema;
  const pend = v.pending_schemas.length ? v.pending_schemas[v.pending_schemas.length - 1] : null;
  const bundled = !!pend?.proposed_with && !head;
  const cols = diffColumns(head, pend);
  const real = !!rows;
  const shown: Record<string, any>[] = real ? rows! : (pend?.preview || head?.preview || []).slice(0, 6);
  const headPreviewN = (head?.preview || []).length;
  const scope = diffList(head?.scope, pend ? pend.scope : head?.scope);
  const grainChanged = head && pend && head.grain !== pend.grain;
  const future = real && v.member && !/estimate|projection|forecast/i.test(v.name) ? nextPeriod(columns(head?.schema), rows!) : null;
  const added = cols.filter((c) => c.st === "added").length;
  const removed = cols.filter((c) => c.st === "removed").length;
  const isNew = !!pend && !head;
  const names = (ids: string[]) => ids.map((i) => t.names[i] || i).join(", ");
  // a computed table with a number on it can become a prediction market settled by its own calculation
  const canMarket =
    real && v.kind === "derived" && columns(head?.schema).some((c) => c.role === "measure" && (c.type === "number" || c.type === "integer"));

  return (
    <div className={`rnode table ${v.kind} ${isNew ? "proposed" : ""} ${v.answer ? "answer" : ""} ${focus === v.id ? "focused" : ""}`}>
      <Handles />
      <div className="tn-head">
        <span className={`tn-kind ${v.kind}`}>{v.answer ? "answer" : v.kind === "source" ? "source" : isNew ? "proposed table" : "table"}</span>
        <b className="tn-name">{v.name}</b>
        <span className="muted small">
          {real ? `${(v.instance?.row_count ?? 0).toLocaleString()} rows` : head || pend ? "preview" : ""}
        </span>
      </div>
      {v.answer && <div className="answer">{v.answer}</div>}
      {(head || pend) && (
        <div className="tn-meta">
          <span className="label">grain</span>
          {grainChanged ? (
            <>
              <s>{head!.grain}</s> → <span className="added">{pend!.grain}</span>
            </>
          ) : (
            (pend || head)!.grain
          )}
          {scope.length > 0 && (
            <div className="chips">
              {scope.map(({ x, st }) => (
                <span key={x} className={`chip ${st}`}>{st === "added" ? "+ " : ""}{x}</span>
              ))}
            </div>
          )}
        </div>
      )}
      {cols.length > 0 && (
        <div className={`tn-rows nodrag nowheel ${real ? "" : "ghost-rows"}`}>
          <table>
            <thead>
              <tr>
                {cols.map((c) => (
                  <th key={c.name} className={c.st} title={c.description}>
                    {c.st === "added" ? "+ " : ""}
                    {c.name}
                    {c.unit && <span className="unit"> {c.unit}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => (
                <tr key={r._rid ?? i} className={`${r._rid ? "clickable" : ""} ${!real && head && pend && i >= headPreviewN ? "added-row" : ""}`}
                    onClick={() => r._rid && onTrace(r._rid)}>
                  {cols.map((c) => (
                    <td key={c.name} className={c.st}>{c.st === "added" && real ? "…" : fmt(r[c.name], c)}</td>
                  ))}
                </tr>
              ))}
              {future && (
                <tr className="future-tr">
                  {cols.map((c) => (
                    <td key={c.name}>{c.name === future.col ? future.next : columns(head?.schema).find((x) => x.name === c.name)?.role === "measure" ? "?" : ""}</td>
                  ))}
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {!real && (head || pend) && <div className="muted small">illustrative rows until it's computed</div>}
      {real && <div className="muted small">click a row to see where it came from</div>}

      {future && (
        <div className="tn-future nodrag">
          <div className="small">
            The data stops at {future.last}. The {future.next} row will be filled by exactly the same calculation once the data is
            published.
          </div>
          <div className="tn-actions">
            <button onClick={() => send(`Estimate ${future.col} ${future.next} from historicals for ${v.name}.`, "chat", [v.id])}>
              Estimate from historicals
            </button>
            {canMarket && (
              <button className="approve" onClick={() => setMarket(true)} title="A YES/NO market on this row, settled by this exact calculation">
                Ask the market
              </button>
            )}
          </div>
        </div>
      )}
      {canMarket && !future && (
        <div className="tn-market nodrag">
          <button onClick={() => setMarket(true)}>Make it a market</button>
          <span className="muted small">a YES/NO bet on a number here, settled by this calculation</span>
        </div>
      )}
      {market &&
        createPortal(
          <MarketDraft
            viewId={v.id}
            intentId={t.intent.id}
            initialWhere={future ? { [future.col]: future.next } : undefined}
            onClose={() => setMarket(false)}
            onCreated={() => reload()}
          />,
          document.body,
        )}

      {pend && (
        <div className="tn-proposal nodrag">
          <div className="small">
            <b>{isNew ? "Proposed table" : `Proposed change${added ? ` · +${added} column${added > 1 ? "s" : ""}` : ""}${removed ? ` · −${removed}` : ""}`}</b>
            {pend.rationale && <span className="clamp" title={pend.rationale}> — {pend.rationale}</span>}
            {v.pending_schemas.length > 1 && <span className="muted"> (+{v.pending_schemas.length - 1} other version)</span>}
          </div>
          {bundled ? (
            <div className="muted small">comes with the proposed step above; accept it there</div>
          ) : (
            <div className="tn-actions">
              <button className="approve" disabled={busy}
                      onClick={() => act(pend.id, "approve", isNew ? `Approved the shape of ${v.name}.` : `Approved the change to ${v.name}.`)}>
                Accept
              </button>
              <button disabled={busy} onClick={() => act(pend.id, "discard", `Discarded the proposed ${isNew ? "shape" : "change"} of ${v.name}.`)}>
                Discard
              </button>
            </div>
          )}
        </div>
      )}

      {v.pending_transforms.map((tr) => (
        <div key={tr.id} className="tn-proposal step nodrag">
          <div className="small">
            <b>Proposed: how to compute it</b> <span className={`kind ${tr.kind}`}>{tr.kind}</span>
            {tr.reads.length > 0 && <> from {names(tr.reads)}</>}
            {tr.rationale && <span className="clamp" title={tr.rationale}> — {tr.rationale}</span>}
          </div>
          {!!tr.warnings?.length && <div className="warnings small">{tr.warnings.join("; ")}</div>}
          <div className="tn-actions">
            <button className="approve" disabled={busy} onClick={() => act(tr.id, "approve", `Approved how ${v.name} is computed.`)}>
              Accept
            </button>
            <button disabled={busy} onClick={() => act(tr.id, "discard", `Discarded the proposed computation of ${v.name}.`)}>
              Discard
            </button>
          </div>
        </div>
      ))}
      {v.head_transform && v.kind !== "source" && (
        <div className="muted small tn-how" title={v.head_transform.rationale}>
          computed with <span className={`kind ${v.head_transform.kind}`}>{v.head_transform.kind}</span> from {names(v.head_transform.reads)}
        </div>
      )}

      {v.visuals.length > 0 && (
        <div className="tn-visuals nodrag">
          {v.visuals.map((x) => (
            <span key={x.id} className="tn-visual">
              <button onClick={() => onOpenVisual(x.id, v.id)}>◧ {x.status === "pending" ? "proposed visual" : "visual"}</button>
              {x.status === "pending" && (
                <>
                  <button className="approve" disabled={busy} onClick={() => act(x.id, "approve", `Approved the visual of ${v.name}.`)}>Accept</button>
                  <button disabled={busy} onClick={() => act(x.id, "discard", `Discarded the visual of ${v.name}.`)}>Discard</button>
                </>
              )}
            </span>
          ))}
        </div>
      )}
      {v.instance && v.answer && (
        <div className="nodrag">
          <VerifyReport instanceId={v.instance.id} hash={v.instance.hash} label="fingerprint" />
        </div>
      )}
      {v.instance && !v.answer && v.instance.hash && (
        <div className="muted small">fingerprint <code className="hash">{v.instance.hash.slice(0, 12)}…</code></div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------- data needed

export function DatasetsNode({ data }: NodeProps) {
  const { t, send, focus } = useThread();
  const ids = data.ids as string[];
  return (
    <div className={`rnode datasets-node ${focus === "datasets" ? "focused" : ""}`}>
      <Handle type="target" position={Position.Top} />
      <div className="tn-head">
        <span className="tn-kind need">? data needed</span>
        <span className="muted small">pick a dataset to load</span>
      </div>
      <div className="ds-list nodrag nowheel">
        {ids.map((id) => {
          const d: Dataset | undefined = t.datasets[id];
          if (!d) return null;
          return (
            <div key={id} className={`dataset ${d.available ? "" : "unavailable"}`}>
              <div className="ds-title">{d.title}</div>
              <div className="muted small">{d.publisher} · {d.coverage} · updated {d.updated}</div>
              <div className="ds-desc small">{d.description}</div>
              {d.loaded_as.length > 0 && <div className="muted small">already loaded: {d.loaded_as.map((x) => x.name).join(", ")}</div>}
              <div className="tn-actions">
                {d.available ? (
                  <button className="approve" onClick={() => send(`Use dataset ${id} (${d.title}).`, "action")}>Use this</button>
                ) : (
                  <span className="muted small">not downloaded yet</span>
                )}
                <a href={d.url} target="_blank" rel="noreferrer" className="small">about ↗</a>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
