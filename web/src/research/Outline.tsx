import { useEffect, useState } from "react";
import { Dataset, op } from "../api";
import { useThread } from "./ctx";
import { QCOLORS, questionChains } from "./ResearchCanvas";

/** The workspace outline: its questions and its tables (sources + computed), in two tabs, plus "+ Question" and
 * "+ Data". Clicking a question highlights its chain on the canvas; clicking a table focuses it. */
export default function Outline() {
  const { t, send, focus, setFocus, activeQ, setActiveQ, openNotebook } = useThread();
  const c = t.canvas;
  const [tab, setTab] = useState<"questions" | "tables">("questions");
  const [asking, setAsking] = useState(false);
  const [text, setText] = useState("");
  const [picking, setPicking] = useState(false);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  useEffect(() => {
    if (picking) op<{ datasets: Dataset[] }>("list_datasets").then((r) => setDatasets(r.datasets)).catch(() => setDatasets([]));
  }, [picking]);
  const chains = questionChains(c);
  const sources = c.nodes.filter((v) => v.kind === "source");
  const tables = c.nodes.filter((v) => v.kind !== "source");

  const ask = async () => {
    const x = text.trim();
    if (!x) return;
    await send(`New question: ${x}`);
    setText("");
    setAsking(false);
  };

  return (
    <aside className="outline">
      <div className="ol-tabs">
        <button className={tab === "questions" ? "active" : ""} onClick={() => setTab("questions")}>
          Questions <span className="muted">{c.questions.length}</span>
        </button>
        <button className={tab === "tables" ? "active" : ""} onClick={() => setTab("tables")}>
          Tables <span className="muted">{c.nodes.length}</span>
        </button>
      </div>
      {tab === "questions" ? (
        <div className="ol-list">
          {c.questions.map((q, i) => (
            <a key={q.id} className={`ol-q ${activeQ === q.id ? "active" : ""}`}
               onClick={() => (setActiveQ(activeQ === q.id ? null : q.id), setFocus(`q:${q.id}`))}>
              <span className="qdot" style={{ background: QCOLORS[i % QCOLORS.length] }} />
              <span className="ol-text">
                {q.text}
                <span className="muted small">
                  {q.status === "answered" ? " · answered" : " · open"} · {chains.get(q.id)?.size ?? 0} tables
                </span>
              </span>
            </a>
          ))}
          {asking ? (
            <form className="ol-form" onSubmit={(e) => (e.preventDefault(), ask())}>
              <textarea autoFocus rows={3} value={text} onChange={(e) => setText(e.target.value)}
                        placeholder="Another question for this workspace…"
                        onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), ask())} />
              <div className="tn-actions">
                <button className="approve" disabled={!text.trim()}>Ask</button>
                <button type="button" onClick={() => setAsking(false)}>Cancel</button>
              </div>
            </form>
          ) : (
            <button className="ol-add" onClick={() => setAsking(true)}>+ Question</button>
          )}
        </div>
      ) : (
        <div className="ol-list">
          <div className="label">computed</div>
          {tables.map((v) => <TableLine key={v.id} id={v.id} />)}
          <div className="label">data</div>
          {sources.map((v) => <TableLine key={v.id} id={v.id} />)}
          {picking ? (
            <div className="ol-pick">
              {datasets.filter((d) => d.available).map((d) => (
                <button key={d.id} onClick={() => (send(`Use dataset ${d.id} (${d.title}) in this workspace.`, "action"), setPicking(false))}>
                  <b>{d.title}</b>
                  <span className="muted small">{d.coverage}</span>
                </button>
              ))}
              <button onClick={() => setPicking(false)}>Cancel</button>
            </div>
          ) : (
            <button className="ol-add" onClick={() => setPicking(true)}>+ Data</button>
          )}
        </div>
      )}
    </aside>
  );

  function TableLine({ id }: { id: string }) {
    const v = c.nodes.find((x) => x.id === id)!;
    const cols = c.questions.map((q, i) => (chains.get(q.id)?.has(id) ? QCOLORS[i % QCOLORS.length] : null)).filter(Boolean);
    return (
      <a className={`ol-t ${focus === id ? "active" : ""}`} onClick={() => setFocus(id)}>
        {cols.map((cl) => <span key={cl!} className="qdot" style={{ background: cl! }} />)}
        <span className="ol-text">
          {v.name}
          <span className="muted small"> · {v.instance ? `${(v.instance.row_count ?? 0).toLocaleString()} rows` : "not computed"}</span>
        </span>
        {v.head_schema && (
          <button className="nb-open" title="notebook" onClick={(e) => (e.stopPropagation(), openNotebook(id))}>⟨/⟩</button>
        )}
      </a>
    );
  }
}
