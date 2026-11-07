import { useEffect, useState } from "react";
import { op } from "./api";
import { CanvasTarget } from "./Canvas";

type Step = {
  id: string;
  kind: "schema" | "transform" | "visual";
  view_id: string;
  view_name: string;
  status: string;
  decided_by?: string;
  rationale?: string;
  created_at: string;
  transform_kind?: string;
  reads: string[];
};

const KIND = { schema: "shape", transform: "transform", visual: "visual" } as const;

// "Under the hood" of an intent: the request, its answer, and the ordered story of steps taken to get there.
export default function IntentPanel(props: {
  intentId: string;
  tick: number;
  expanded: boolean;
  onToggleExpand: () => void;
  onOpen: (t: CanvasTarget) => void;
  onClose: () => void;
}) {
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    op("get_intent", { intent_id: props.intentId }).then(setD).catch((e) => setErr(e.message));
  }, [props.intentId, props.tick]);

  if (err) return <aside className="panel"><div className="error pad">{err}</div></aside>;
  if (!d) return <aside className="panel"><div className="muted pad">loading…</div></aside>;
  const q = d.intent;
  const name = (id: string) => d.names[id] || id;
  const steps: Step[] = d.steps.filter((s: Step) => s.status !== "discarded");
  const discarded = d.steps.length - steps.length;

  return (
    <aside className="panel">
      <div className="panel-head">
        <div>
          <div className="label">intent · {q.mode} · {q.status}</div>
          <h2 className="qtitle">“{q.text}”</h2>
          {q.summary && <div className="answer">{q.summary}</div>}
          <div className="muted small">
            {q.inputs.length > 0 && <>from {q.inputs.map(name).join(", ")} · </>}
            {q.steps} steps
          </div>
        </div>
        <button className="close" onClick={props.onClose}>×</button>
      </div>
      <div className="tab-body">
        <div className="intent-actions">
          {q.result_current && (
            <button
              className="approve"
              onClick={() =>
                props.onOpen({ type: "view", viewId: q.result_view_id, tab: q.result_kind === "visual" ? "visual" : "data" })
              }
            >
              Open result
            </button>
          )}
          <button onClick={props.onToggleExpand}>{props.expanded ? "Collapse path on canvas" : "Lift the hood (expand path)"}</button>
        </div>
        <h3>How it got here</h3>
        <ol className="story">
          {steps.map((s) => (
            <li key={s.id} className={s.status}>
              <a onClick={() => props.onOpen({ type: "view", viewId: s.view_id, tab: s.kind })}>
                <span className={`kind ${s.transform_kind || ""}`}>{KIND[s.kind]}{s.transform_kind ? ` · ${s.transform_kind}` : ""}</span>{" "}
                <b>{s.view_name}</b>
                {s.reads.length > 0 && <span className="muted"> ← {s.reads.join(", ")}</span>}
              </a>
              {s.rationale && <div>{s.rationale}</div>}
              <div className="muted small">
                {s.status}
                {s.decided_by ? ` by ${s.decided_by}` : ""} · {s.created_at.replace("T", " ").slice(0, 19)}
              </div>
            </li>
          ))}
        </ol>
        {discarded > 0 && <div className="muted small">{discarded} discarded proposal(s) hidden — see the view panels.</div>}
        {d.children.length > 0 && (
          <>
            <h3>Follow-ups</h3>
            <ul>
              {d.children.map((c: any) => (
                <li key={c.id}>
                  <a onClick={() => props.onOpen({ type: "intent", intentId: c.id })}>“{c.text}”</a>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </aside>
  );
}
