import { useCallback, useEffect, useState } from "react";
import { Kind, op, ViewDetail } from "./api";
import ProposalCards from "./ProposalCards";
import ShapeBody from "./ShapeBody";

const TABS: { kind: Kind; label: string }[] = [
  { kind: "schema", label: "Shape" },
  { kind: "visual", label: "Visual" },
  { kind: "transform", label: "Transform" },
];

export default function ViewPanel(props: { viewId: string; tick: number; onClose: () => void }) {
  const [detail, setDetail] = useState<ViewDetail | null>(null);
  const [tab, setTab] = useState<Kind>("schema");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    op<ViewDetail>("get_view", { view_id: props.viewId })
      .then((d) => (setDetail(d), setError(null)))
      .catch((e) => setError(e.message));
  }, [props.viewId]);

  useEffect(load, [load, props.tick]);

  if (error) return <aside className="panel"><div className="error pad">{error}</div></aside>;
  if (!detail) return <aside className="panel"><div className="muted pad">loading…</div></aside>;

  const v = detail.view;
  return (
    <aside className="panel">
      <div className="panel-head">
        <div>
          <h2>{v.name}</h2>
          {v.question && <div className="question">“{v.question}”</div>}
        </div>
        <button className="close" onClick={props.onClose}>×</button>
      </div>
      <nav className="tabs">
        {TABS.map((t) => {
          const pending = detail.proposals[t.kind].filter((p) => p.status === "pending").length;
          return (
            <button key={t.kind} className={tab === t.kind ? "active" : ""} onClick={() => setTab(t.kind)}>
              {t.label}
              {pending > 0 && <span className="count">{pending}</span>}
            </button>
          );
        })}
      </nav>
      <div className="tab-body">
        <ProposalCards
          proposals={detail.proposals[tab]}
          headId={detail.head[tab]}
          comments={detail.comments}
          onChange={load}
          empty={`No ${TABS.find((t) => t.kind === tab)!.label.toLowerCase()} proposals yet.`}
          renderBody={(p) =>
            tab === "schema" ? <ShapeBody p={p} /> : <pre className="small">{JSON.stringify(p.spec ?? p.html ?? p, null, 2)}</pre>
          }
        />
      </div>
    </aside>
  );
}
