import { useCallback, useEffect, useMemo, useState } from "react";
import { columns, Graph, Kind, op, Proposal, ViewDetail } from "./api";
import ProposalCards from "./ProposalCards";
import RowsTable from "./RowsTable";
import ShapeBody from "./ShapeBody";
import TransformBody from "./TransformBody";
import VisualFrame from "./VisualFrame";

type Tab = Kind | "data";
const TABS: { key: Tab; label: string }[] = [
  { key: "schema", label: "Shape" },
  { key: "visual", label: "Visual" },
  { key: "transform", label: "Transform" },
  { key: "data", label: "Data" },
];

type Rows = { mode: "preview" | "instance"; rows: Record<string, any>[]; total: number; instance?: any };

export default function ViewPanel(props: {
  viewId: string;
  tick: number;
  graph: Graph;
  onClose: () => void;
  onSelectRecord: (rid: string) => void;
}) {
  const [detail, setDetail] = useState<ViewDetail | null>(null);
  const [tab, setTab] = useState<Tab>("schema");
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Rows | null>(null);

  const load = useCallback(() => {
    op<ViewDetail>("get_view", { view_id: props.viewId })
      .then((d) => (setDetail(d), setError(null)))
      .catch((e) => setError(e.message));
  }, [props.viewId]);
  useEffect(load, [load, props.tick]);

  // shape used for visuals/data: head, else newest pending
  const shape: Proposal | undefined = useMemo(() => {
    if (!detail) return undefined;
    const ss = detail.proposals.schema;
    return ss.find((s) => s.id === detail.head.schema) || ss[ss.length - 1];
  }, [detail]);

  const instanceId = detail?.latest_instance?.id;
  useEffect(() => {
    if (!detail) return;
    if (instanceId) {
      op("get_records", { instance_id: instanceId, limit: 2000 }).then((r) =>
        setData({ mode: "instance", rows: r.rows, total: r.total, instance: r.instance }),
      );
    } else {
      setData({ mode: "preview", rows: shape?.preview || [], total: shape?.preview?.length || 0 });
    }
  }, [instanceId, shape?.id, props.viewId]);

  const names = useMemo(() => new Map(props.graph.views.map((v) => [v.id, v.name])), [props.graph]);

  if (error) return <aside className="panel"><div className="error pad">{error}</div></aside>;
  if (!detail) return <aside className="panel"><div className="muted pad">loading…</div></aside>;

  const v = detail.view;
  const cols = columns(shape?.schema);
  return (
    <aside className="panel">
      <div className="panel-head">
        <div>
          <h2>
            {v.name} <span className="muted small">{v.kind}</span>
          </h2>
          {v.question && <div className="question">“{v.question}”</div>}
          <div className="muted small">
            {detail.upstream.length > 0 && <>from {detail.upstream.map((u) => names.get(u) || u).join(", ")} · </>}
            {detail.downstream.length > 0 && <>feeds {detail.downstream.map((u) => names.get(u) || u).join(", ")} · </>}
            {detail.latest_instance ? `${detail.latest_instance.row_count} rows evaluated` : "not evaluated"}
          </div>
        </div>
        <button className="close" onClick={props.onClose}>×</button>
      </div>
      <nav className="tabs">
        {TABS.map((t) => {
          const pending = t.key === "data" ? 0 : detail.proposals[t.key].filter((p) => p.status === "pending").length;
          return (
            <button key={t.key} className={tab === t.key ? "active" : ""} onClick={() => setTab(t.key)}>
              {t.label}
              {pending > 0 && <span className="count">{pending}</span>}
            </button>
          );
        })}
      </nav>
      <div className="tab-body">
        {tab === "data" ? (
          <DataTab data={data} cols={cols} visual={detail.proposals.visual.find((p) => p.id === detail.head.visual)}
                   shape={shape} view={v} onSelect={props.onSelectRecord} />
        ) : (
          <ProposalCards
            proposals={detail.proposals[tab]}
            headId={detail.head[tab]}
            comments={detail.comments}
            onChange={load}
            empty={`No ${TABS.find((t) => t.key === tab)!.label.toLowerCase()} proposals yet.`}
            renderBody={(p) =>
              tab === "schema" ? (
                <ShapeBody p={p} />
              ) : tab === "transform" ? (
                <TransformBody p={p} names={names} />
              ) : (
                <VisualFrame html={p.html} schema={shape?.schema} rows={data?.rows || []} mode={data?.mode || "preview"}
                             view={{ id: v.id, name: v.name }} onSelect={props.onSelectRecord} />
              )
            }
          />
        )}
      </div>
    </aside>
  );
}

function DataTab(props: {
  data: Rows | null;
  cols: ReturnType<typeof columns>;
  visual?: Proposal;
  shape?: Proposal;
  view: { id: string; name: string };
  onSelect: (rid: string) => void;
}) {
  const { data } = props;
  if (!data) return <div className="muted">loading…</div>;
  if (data.mode === "preview")
    return <div className="muted pad">Not evaluated yet — the Visual and Shape tabs show preview rows.</div>;
  return (
    <div className="data">
      <div className="muted small">
        instance <code>{data.instance?.id}</code> · {data.total.toLocaleString()} rows · {data.instance?.created_at}
      </div>
      {props.visual && (
        <VisualFrame html={props.visual.html} schema={props.shape?.schema} rows={data.rows} mode="instance"
                     view={props.view} onSelect={props.onSelect} />
      )}
      <RowsTable cols={props.cols} rows={data.rows} onSelect={props.onSelect} />
    </div>
  );
}
