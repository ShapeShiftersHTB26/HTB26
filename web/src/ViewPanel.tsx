import { useCallback, useEffect, useMemo, useState } from "react";
import { columns, Graph, Kind, op, Proposal, ViewDetail } from "./api";
import ProposalCards from "./ProposalCards";
import RowsTable from "./RowsTable";
import ShapeBody from "./ShapeBody";
import TransformBody from "./TransformBody";
import Visual from "./Visual";

export type Tab = Kind | "data";
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
  tab: Tab;
  onTab: (t: Tab) => void;
}) {
  const [detail, setDetail] = useState<ViewDetail | null>(null);
  const { tab, onTab: setTab } = props;
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
          <DataTab data={data} cols={cols} visuals={detail.proposals.visual.filter((p) => detail.visual_heads.includes(p.id))}
                   shape={shape} view={v} graph={props.graph} onSelect={props.onSelectRecord} />
        ) : (
          <ProposalCards
            proposals={detail.proposals[tab]}
            headIds={tab === "visual" ? detail.visual_heads : [detail.head[tab]].filter(Boolean) as string[]}
            comments={detail.comments}
            onChange={load}
            empty={`No ${TABS.find((t) => t.key === tab)!.label.toLowerCase()} proposals yet.`}
            renderBody={(p) =>
              tab === "schema" ? (
                <ShapeBody p={p} />
              ) : tab === "transform" ? (
                <TransformBody p={p} names={names} />
              ) : (
                <Visual p={p} schema={shape?.schema} rows={data?.rows || []} mode={data?.mode || "preview"}
                        view={{ id: v.id, name: v.name }} graph={props.graph} onSelect={props.onSelectRecord} />
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
  visuals: Proposal[];
  shape?: Proposal;
  view: { id: string; name: string };
  graph: Graph;
  onSelect: (rid: string) => void;
}) {
  const { data } = props;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const evaluate = () => {
    setBusy(true);
    setErr(null);
    op("evaluate", { view_id: props.view.id })
      .catch((e) => setErr(e.message))
      .finally(() => setBusy(false));
  };
  if (!data) return <div className="muted">loading…</div>;
  const bar = (
    <div className="data-bar">
      <button className="approve" disabled={busy} onClick={evaluate}>
        {busy ? "evaluating…" : data.mode === "preview" ? "Evaluate" : "Re-evaluate"}
      </button>
      {data.mode === "instance" && (
        <span className="muted small">
          instance <code>{data.instance?.id}</code> · {data.total.toLocaleString()} rows · {data.instance?.created_at}
          {data.instance?.invalid_count ? ` · ${data.instance.invalid_count} invalid dropped` : ""}
        </span>
      )}
      {err && <span className="error small">{err}</span>}
    </div>
  );
  if (data.mode === "preview")
    return (
      <div className="data">
        {bar}
        <div className="muted">Not evaluated yet — the Visual and Shape tabs show preview rows.</div>
      </div>
    );
  return (
    <div className="data">
      {bar}
      {props.visuals.map((vis) => (
        <Visual key={vis.id} p={vis} schema={props.shape?.schema} rows={data.rows} mode="instance"
                view={props.view} graph={props.graph} onSelect={props.onSelect} />
      ))}
      <RowsTable cols={props.cols} rows={data.rows} onSelect={props.onSelect} />
    </div>
  );
}
