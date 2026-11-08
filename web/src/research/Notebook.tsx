import { useCallback, useEffect, useState } from "react";
import { op } from "../api";
import { useThread } from "./ctx";

type Cell = {
  view_id: string;
  name: string;
  kind: string;
  transform_id?: string;
  reads: string[];
  rationale?: string;
  inputs: string[];
  code: string;
  lineage: string;
  columns: string[];
  instance: { id: string; hash?: string; row_count?: number; formula_hash?: string } | null;
  rows: Record<string, any>[];
  pending: { id: string; kind: string; rationale?: string; author?: string; code: string }[];
};
type Preview = { row_count: number; columns: string[]; rows: Record<string, any>[]; lineage: string };

const EDITABLE = new Set(["ops", "python"]);

/** The receipt of a table as notebook cells: each step that produced it, sources first, as code you can read,
 * re-run as a preview, edit into a Python step (the escape hatch), and export. */
export default function Notebook(props: { viewId: string; onClose: () => void }) {
  const { t, reload } = useThread();
  const [cells, setCells] = useState<Cell[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(
    () =>
      op<{ cells: Cell[] }>("get_notebook", { view_id: props.viewId })
        .then((d) => (setCells(d.cells), setErr(null)))
        .catch((e) => setErr(e.message)),
    [props.viewId],
  );
  useEffect(() => {
    setCells(null);
    load();
  }, [load]);

  const download = async (format: "py" | "ipynb") => {
    const r = await op<{ filename: string; content: string }>("export_notebook", { view_id: props.viewId, format });
    const url = URL.createObjectURL(new Blob([r.content], { type: "text/plain" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: r.filename });
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <aside className="notebook nodrag nowheel">
      <div className="nb-head">
        <div>
          <div className="label">notebook · the receipt</div>
          <b>{t.names[props.viewId] || props.viewId}</b>
        </div>
        <span className="grow" />
        <button onClick={() => download("py")} title="A pandas script that rebuilds this from the source files">⤓ .py</button>
        <button onClick={() => download("ipynb")}>⤓ .ipynb</button>
        <button className="close" onClick={props.onClose}>×</button>
      </div>
      <div className="nb-body">
        {err && <div className="error small">{err}</div>}
        {!cells && !err && <div className="muted small">loading…</div>}
        {cells?.map((c, i) => (
          <CellView key={c.view_id} c={c} n={i + 1} last={i === cells.length - 1}
                    onChanged={() => (load(), reload())} />
        ))}
      </div>
    </aside>
  );
}

function CellView(props: { c: Cell; n: number; last: boolean; onChanged: () => void }) {
  const { c } = props;
  const { send } = useThread();
  const [editing, setEditing] = useState(false);
  const [code, setCode] = useState(c.code);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ver, setVer] = useState<boolean | null>(null);
  useEffect(() => setCode(c.code), [c.code]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const runPreview = () => run(async () => setPreview(await op<Preview>("preview_transform", { view_id: c.view_id, code })));
  const propose = () =>
    run(async () => {
      await op("propose_transform", {
        view_id: c.view_id, kind: "python", spec: { code }, reads: c.reads, parent_id: c.transform_id,
        author: "user", rationale: "Edited in the notebook.",
      });
      setEditing(false);
      setPreview(null);
      props.onChanged();
    });
  const accept = (id: string) =>
    run(async () => {
      await op("decide", { target_id: id, decision: "approve" });
      await op("evaluate", { view_id: c.view_id });
      await send(`Edited the code of ${c.name} in the notebook, approved it and re-ran it.`, "action", [c.view_id]);
      props.onChanged();
    });
  const discard = (id: string) => run(async () => (await op("decide", { target_id: id, decision: "discard" }), props.onChanged()));
  const verify = () => run(async () => setVer((await op<{ ok: boolean }>("verify", { instance_id: c.instance!.id })).ok));
  const shown = preview?.rows || c.rows;
  const cols = (preview?.columns || c.columns).slice(0, 8);

  return (
    <section className={`nb-cell ${props.last ? "result" : ""}`}>
      <div className="nb-cell-head">
        <span className="nb-n">[{props.n}]</span>
        <span className={`kind ${c.kind}`}>{c.kind}</span>
        <b>{c.name}</b>
        {c.inputs.length > 0 && <span className="muted small">← {c.inputs.join(", ")}</span>}
        <span className="grow" />
        <span className="chip" title="how far each row can be traced back">lineage: {c.lineage}</span>
      </div>
      {c.rationale && <div className="muted small nb-why">{c.rationale}</div>}
      {editing ? (
        <textarea className="nb-code edit" value={code} spellCheck={false} onChange={(e) => setCode(e.target.value)}
                  rows={Math.min(18, code.split("\n").length + 2)} />
      ) : (
        <pre className="nb-code">{c.code}</pre>
      )}
      <div className="nb-actions">
        {EDITABLE.has(c.kind) && !editing && <button onClick={() => setEditing(true)}>Edit as Python</button>}
        {editing && (
          <>
            <button disabled={busy} onClick={runPreview}>▶ Run (preview)</button>
            <button className="approve" disabled={busy || code === c.code} onClick={propose}>Propose this version</button>
            <button disabled={busy} onClick={() => (setEditing(false), setCode(c.code), setPreview(null))}>Cancel</button>
            <span className="muted small">inputs: {c.inputs.join(", ")} · assign the result to <code>df</code></span>
          </>
        )}
        <span className="grow" />
        {c.instance && (
          <>
            <span className="muted small">{(c.instance.row_count ?? 0).toLocaleString()} rows</span>
            <code className="hash" title={c.instance.hash}>{(c.instance.hash || "").slice(0, 12)}…</code>
            <button disabled={busy} onClick={verify}>{ver === null ? "Verify" : ver ? "verified ✓" : "MISMATCH ✗"}</button>
          </>
        )}
      </div>
      {err && <div className="error small">{err}</div>}
      {preview && (
        <div className="muted small">
          preview: {preview.row_count.toLocaleString()} rows · lineage {preview.lineage} · not stored
        </div>
      )}
      {shown.length > 0 && (
        <div className="nb-out">
          <table>
            <thead>
              <tr>{cols.map((k) => <th key={k}>{k}</th>)}</tr>
            </thead>
            <tbody>
              {shown.slice(0, 5).map((r, i) => (
                <tr key={i}>{cols.map((k) => <td key={k}>{fmt(r[k])}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {c.pending.map((p) => (
        <div key={p.id} className="tn-proposal step">
          <div className="small">
            <b>Proposed {p.kind} version</b> by {p.author || "agent"}{p.rationale ? ` — ${p.rationale}` : ""}
          </div>
          <pre className="nb-code">{p.code}</pre>
          <div className="tn-actions">
            <button className="approve" disabled={busy} onClick={() => accept(p.id)}>Accept &amp; re-run</button>
            <button disabled={busy} onClick={() => discard(p.id)}>Discard</button>
          </div>
        </div>
      ))}
    </section>
  );
}

function fmt(v: any) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
