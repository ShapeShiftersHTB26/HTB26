import { Handle, NodeProps, Position } from "@xyflow/react";
import { ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Column, columns, Dataset, op, Proposal } from "../api";
import Icon from "../Icon";
import VerifyReport from "../VerifyReport";
import { useThread } from "./ctx";
import MarketDraft from "./MarketDraft";
import "./nodes.css";
import { DataGrid, DiffState, GridCol, prettyName, rowsLabel, sentence } from "./table";

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

export type Question = {
  id: string;
  text: string;
  status: string;
  stage: "ask" | "shape" | "data" | "answer" | "answered";
  summary?: string;
  parent_id?: string;
  result_view_id?: string;
  views: string[];
};

export function QuestionNode({ data }: NodeProps) {
  const q = data.q as Question;
  const color = data.color as string;
  const answered = q.status === "answered";
  return (
    <div className={`rnode question ${data.active ? "active" : ""}`}
         style={{ borderTopColor: color, boxShadow: data.active ? `0 0 0 3px ${color}33, 0 6px 20px rgba(0,0,0,.08)` : undefined }}>
      <div className="qn-eyebrow">
        <span className="qdot" style={{ background: color }} />
        Question {data.n as number}
        <span className={`qn-status ${answered ? "answered" : "open"}`}>{answered ? "Answered" : "Open"}</span>
      </div>
      <div className="q">{q.text}</div>
      <MiniRail stage={q.stage} />
      {q.summary && (
        <div className="qanswer">
          <Icon name="check" size={15} />
          <div>
            <div className="qanswer-label">Answer</div>
            {q.summary}
          </div>
        </div>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const STAGES = ["ask", "shape", "data", "answer"] as const;
/** One question's progress through ask -> shape -> data -> answer, as small labelled dots (all ticked once answered). */
export function MiniRail({ stage }: { stage: Question["stage"] }) {
  const at = stage === "answered" ? STAGES.length : STAGES.indexOf(stage);
  return (
    <div className="minirail">
      {STAGES.map((s, i) => (
        <span key={s} className={i < at ? "done" : i === at ? "current" : "todo"}>
          <i />
          {s}
        </span>
      ))}
    </div>
  );
}

export function NoteNode({ data }: NodeProps) {
  const n = data.note as Note;
  return (
    <div className={`rnode note by-${n.author}`}>
      <Handle type="target" position={Position.Top} />
      <div className="note-by">{n.author === "user" ? "Your note" : "Agent note"}</div>
      <div className="note-text">{n.text}</div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

// ------------------------------------------------------------------------------------------- table node

type DiffCol = Column & { st: DiffState };

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

type Kind = "answer" | "source" | "proposed" | "table";
const KIND_LABEL: Record<Kind, string> = { answer: "Answer", source: "Source data", proposed: "Proposed table", table: "Table" };
// how a table is computed, said only when it changes how far rows can be traced (plain ops are the default)
const STEP_TAG: Record<string, string> = { python: "Python", agent_map: "AI, row by row", agent_reduce: "AI summary" };

/** Small caps line above a card's title: which questions use it, what it is, how big it is, and its tools. */
function Eyebrow(props: { colors: string[]; kind: Kind; meta?: string; review?: boolean; children?: ReactNode }) {
  return (
    <div className="tn-eyebrow">
      {props.colors.length > 0 && (
        <span className="tn-qdots" title="Questions that use this table">
          {props.colors.map((c) => <i key={c} style={{ background: c }} />)}
        </span>
      )}
      <span className={`tn-kind k-${props.kind}`}>{KIND_LABEL[props.kind]}</span>
      {props.meta && <span className="tn-meta">{props.meta}</span>}
      {props.review && <span className="tn-pill warn">Needs review</span>}
      <span className="grow" />
      {props.children}
    </div>
  );
}

/** A decision waiting on the user: what is proposed, why, and Accept / Discard. */
function Review(props: {
  tone: "shape" | "step" | "visual";
  title: string;
  note?: ReactNode;
  why?: string;
  warnings?: string[];
  busy: boolean;
  waiting?: string;
  onAccept: () => void;
  onDiscard: () => void;
  onPreview?: () => void;
}) {
  return (
    <div className={`tn-review ${props.tone} nodrag`}>
      <div className="tn-review-head">
        <b>{props.title}</b>
        {props.note && <span className="tn-review-note">{props.note}</span>}
      </div>
      {props.why && <div className="tn-review-why" title={props.why}>{props.why}</div>}
      {!!props.warnings?.length && (
        <ul className="tn-warn">
          {props.warnings.map((w) => <li key={w}>{w}</li>)}
        </ul>
      )}
      {props.waiting ? (
        <div className="tn-review-wait">{props.waiting}</div>
      ) : (
        <div className="tn-btns">
          {props.onPreview && (
            <button className="btn" onClick={props.onPreview}>
              <Icon name="chart" /> Preview
            </button>
          )}
          <span className="grow" />
          <button className="btn" disabled={props.busy} onClick={props.onDiscard}>Discard</button>
          <button className="btn primary" disabled={props.busy} onClick={props.onAccept}>
            <Icon name="check" /> Accept
          </button>
        </div>
      )}
    </div>
  );
}

export function TableNode({ data }: NodeProps) {
  const v = data.view as CanvasView;
  const { t, send, reload, focus, onOpenVisual, onTrace, openNotebook } = useThread();
  const { busy, act } = useAct();
  const [rows, setRows] = useState<Record<string, any>[] | null>(null);
  const [market, setMarket] = useState(false);
  const [scopeOpen, setScopeOpen] = useState<boolean | null>(null);
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
  const isNew = !!pend && !head;
  // a brand-new table has nothing to diff against: its scope is shown plainly (and open, since it's under review)
  const scope = isNew ? (pend!.scope || []).map((x: string) => ({ x, st: "same" })) : diffList(head?.scope, pend ? pend.scope : head?.scope);
  const scopeChanged = scope.some((s: { st: string }) => s.st !== "same");
  const grainChanged = !!(head && pend && head.grain !== pend.grain);
  const grain = (pend || head)?.grain as string | undefined;
  const future = real && v.member && !/estimate|projection|forecast/i.test(v.name) ? nextPeriod(columns(head?.schema), rows!) : null;
  const added = cols.filter((c) => c.st === "added").length;
  const removed = cols.filter((c) => c.st === "removed").length;
  const names = (ids: string[]) => ids.map((i) => prettyName(t.names[i] || i)).join(", ");
  // a computed table with a number on it can become a prediction market settled by its own calculation
  const canMarket =
    real && v.kind === "derived" && columns(head?.schema).some((c) => c.role === "measure" && (c.type === "number" || c.type === "integer"));
  const qcolors = (data.colors as string[]) || [];
  const total = v.instance?.row_count ?? 0;
  const kind: Kind = v.answer ? "answer" : v.kind === "source" ? "source" : isNew ? "proposed" : "table";
  const visualsPending = v.visuals.filter((x) => x.status === "pending");
  const visualsReady = v.visuals.filter((x) => x.status !== "pending");
  const reviewCount = (pend ? 1 : 0) + v.pending_transforms.length + visualsPending.length;
  const rowsText = v.instance ? rowsLabel(total) : head || pend ? "not computed yet" : "";
  const codeBtn = (stop: boolean) =>
    head && (
      <button className="icon-btn nodrag" title="Open the steps behind this table, as code"
              onClick={(e) => (stop && e.stopPropagation(), openNotebook(v.id))}>
        <Icon name="code" />
      </button>
    );

  if (data.compact) {
    const names = columns(head?.schema).map((c) => c.name);
    return (
      <div className={`rnode table compact k-${kind}`} title="Click to expand">
        <Handles />
        <Eyebrow colors={qcolors} kind={kind} meta={rowsText}>{codeBtn(true)}</Eyebrow>
        <div className="tn-title one" title={v.name}>{prettyName(v.name)}</div>
        {names.length > 0 && <div className="tn-cols" title={names.join(", ")}>{names.join(" · ")}</div>}
      </div>
    );
  }

  const scopeIsOpen = scopeOpen ?? (scopeChanged || isNew);
  const traceable = real && shown.some((r) => r._rid);
  return (
    <div className={`rnode table k-${kind} ${focus === v.id ? "focused" : ""}`}>
      <Handles />
      <div className="tn-top">
        <Eyebrow colors={qcolors} kind={kind} meta={rowsText} review={reviewCount > 0 && !isNew}>{codeBtn(false)}</Eyebrow>
        <div className="tn-title" title={v.name}>{prettyName(v.name)}</div>
        {grain && (
          <div className="tn-grain" title={grain}>
            {grainChanged ? (
              <>
                <s>{sentence(head!.grain)}</s> → <span className="added">{pend!.grain}</span>
              </>
            ) : (
              sentence(grain)
            )}
          </div>
        )}
      </div>
      {cols.length > 0 && real && !shown.length && (
        <div className="tn-empty">
          <div>No rows stored to preview</div>
          <div className="tn-cols" title={cols.map((c) => c.name).join(", ")}>{cols.map((c) => c.name).join(" · ")}</div>
        </div>
      )}
      {cols.length > 0 && (shown.length > 0 || !real) && (
        <>
          <DataGrid
            className="tn-grid"
            cols={cols as GridCol[]}
            rows={shown}
            ghost={!real}
            onRow={real ? (r) => onTrace(r._rid) : undefined}
            rowTitle="Trace this row back to its source"
            rowClass={(_, i) => (!real && head && pend && i >= headPreviewN ? "added-row" : "")}
            cell={(_, c) => (c.st === "added" && real ? "…" : undefined)}
            tail={
              future && (
                <tr className="future-tr">
                  {cols.map((c) => (
                    <td key={c.name} className={c.role === "measure" ? "num" : ""}>
                      {c.name === future.col ? future.next : c.role === "measure" ? "?" : ""}
                    </td>
                  ))}
                </tr>
              )
            }
          />
          {(!real || traceable || shown.length < total) && (
            <div className="tn-gridnote">
              {!real ? (
                "Example rows. Real values appear once it's computed."
              ) : (
                <>
                  {shown.length < total && <span>First {shown.length} of {total.toLocaleString()}</span>}
                  {traceable && <span>Click a row to trace it</span>}
                </>
              )}
            </div>
          )}
        </>
      )}

      {future && (
        <div className="tn-callout nodrag">
          <div className="tn-callout-text">
            <Icon name="clock" />
            <span>
              Data ends at <b>{future.last}</b>. The <b>{future.next}</b> row fills in with the same calculation once it's published.
            </span>
          </div>
          <div className="tn-btns">
            <button className="btn" onClick={() => send(`Estimate ${future.col} ${future.next} from historicals for ${v.name}.`, "chat", [v.id])}>
              Estimate from history
            </button>
            {canMarket && (
              <button className="btn primary" onClick={() => setMarket(true)} title="A YES/NO market on this row, settled by this exact calculation">
                <Icon name="market" /> Ask the market
              </button>
            )}
          </div>
        </div>
      )}

      {scope.length > 0 && (
        <div className="tn-scope">
          <button className={`tn-disclose nodrag ${scopeIsOpen ? "open" : ""}`} onClick={(e) => (e.stopPropagation(), setScopeOpen(!scopeIsOpen))}>
            <Icon name="chevron" size={12} />
            Scope and assumptions
            <span className="tn-count">{scope.length}</span>
            {scopeChanged && <span className="tn-pill warn">changed</span>}
          </button>
          {scopeIsOpen && (
            <ul>
              {scope.map(({ x, st }: { x: string; st: string }) => (
                <li key={x} className={st}>{sentence(x)}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {pend && (
        <Review
          tone="shape"
          title={isNew ? "Proposed table" : "Proposed change"}
          note={
            <>
              {added > 0 && <span className="added">+{added} column{added > 1 ? "s" : ""}</span>}
              {removed > 0 && <span className="removed">−{removed} column{removed > 1 ? "s" : ""}</span>}
              {v.pending_schemas.length > 1 && <span>+{v.pending_schemas.length - 1} other version</span>}
            </>
          }
          why={pend.rationale}
          busy={busy}
          waiting={bundled ? "Comes with the proposed calculation below. Accept it there." : undefined}
          onAccept={() => act(pend.id, "approve", isNew ? `Approved the shape of ${v.name}.` : `Approved the change to ${v.name}.`)}
          onDiscard={() => act(pend.id, "discard", `Discarded the proposed ${isNew ? "shape" : "change"} of ${v.name}.`)}
        />
      )}
      {v.pending_transforms.map((tr) => (
        <Review
          key={tr.id}
          tone="step"
          title="How to compute it"
          note={
            <>
              {tr.reads.length > 0 && <span>from {names(tr.reads)}</span>}
              {STEP_TAG[tr.kind] && <span className={`tn-tag ${tr.kind}`}>{STEP_TAG[tr.kind]}</span>}
            </>
          }
          why={tr.rationale}
          warnings={tr.warnings}
          busy={busy}
          onAccept={() => act(tr.id, "approve", `Approved how ${v.name} is computed.`)}
          onDiscard={() => act(tr.id, "discard", `Discarded the proposed computation of ${v.name}.`)}
        />
      ))}
      {visualsPending.map((x) => (
        <Review
          key={x.id}
          tone="visual"
          title="Proposed visual"
          why={x.rationale}
          busy={busy}
          onPreview={() => onOpenVisual(x.id, v.id)}
          onAccept={() => act(x.id, "approve", `Approved the visual of ${v.name}.`)}
          onDiscard={() => act(x.id, "discard", `Discarded the visual of ${v.name}.`)}
        />
      ))}

      {(visualsReady.length > 0 || (canMarket && !future)) && (
        <div className="tn-bar nodrag">
          {visualsReady.map((x) => (
            <button key={x.id} className="btn" onClick={() => onOpenVisual(x.id, v.id)}>
              <Icon name="chart" /> Open visual
            </button>
          ))}
          {canMarket && !future && (
            <button className="btn" onClick={() => setMarket(true)} title="A YES/NO market on a number in this table, settled by this exact calculation">
              <Icon name="market" /> Make a market
            </button>
          )}
        </div>
      )}

      {((v.head_transform && v.kind !== "source") || v.instance) && (
        <div className="tn-foot nodrag">
          {v.head_transform && v.kind !== "source" ? (
            <span className="tn-from" title={v.head_transform.rationale}>
              Built from <b>{names(v.head_transform.reads)}</b>
              {STEP_TAG[v.head_transform.kind] && <span className={`tn-tag ${v.head_transform.kind}`}>{STEP_TAG[v.head_transform.kind]}</span>}
            </span>
          ) : (
            <span className="tn-from">{v.kind === "source" ? "Loaded from a source file" : ""}</span>
          )}
          <span className="grow" />
          {v.instance && <VerifyReport compact instanceId={v.instance.id} hash={v.instance.hash} />}
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
      <div className="tn-eyebrow">
        <span className="tn-kind k-need">Data needed</span>
        <span className="tn-meta">pick a dataset to load</span>
      </div>
      <div className="ds-list nodrag nowheel">
        {ids.map((id) => {
          const d: Dataset | undefined = t.datasets[id];
          if (!d) return null;
          return (
            <div key={id} className={`dataset ${d.available ? "" : "unavailable"}`}>
              <div className="ds-title">{d.title}</div>
              <div className="ds-meta">{d.publisher} · {d.coverage} · updated {d.updated}</div>
              <div className="ds-desc">{d.description}</div>
              {d.loaded_as.length > 0 && <div className="ds-meta">Already loaded as {d.loaded_as.map((x) => x.name).join(", ")}</div>}
              <div className="tn-btns">
                {d.available ? (
                  <button className="btn primary" onClick={() => send(`Use dataset ${id} (${d.title}).`, "action")}>Use this</button>
                ) : (
                  <span className="ds-meta">Not downloaded yet</span>
                )}
                <a href={d.url} target="_blank" rel="noreferrer" className="ds-link">About ↗</a>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
