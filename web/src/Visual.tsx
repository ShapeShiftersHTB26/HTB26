import { useEffect, useState } from "react";
import { Graph, op, Proposal, ViewDetail } from "./api";
import VisualFrame, { ViewData } from "./VisualFrame";

// Data for one view: real rows of its latest instance, else the head (or newest) shape's preview rows.
export async function loadViewData(viewId: string): Promise<ViewData & { name: string }> {
  const d = await op<ViewDetail>("get_view", { view_id: viewId });
  const ss = d.proposals.schema;
  const shape = ss.find((s) => s.id === d.head.schema) || ss[ss.length - 1];
  if (d.latest_instance) {
    const r = await op("get_records", { instance_id: d.latest_instance.id, limit: 2000 });
    return { view_id: viewId, name: d.view.name, schema: shape?.schema, rows: r.rows, mode: "instance" };
  }
  return { view_id: viewId, name: d.view.name, schema: shape?.schema, rows: shape?.preview || [], mode: "preview" };
}

// A visual proposal rendered over its own view's rows plus the rows of every view it `uses`.
export default function Visual(props: {
  p: Proposal;
  schema: any;
  rows: Record<string, any>[];
  mode: "preview" | "instance";
  view: { id: string; name: string };
  graph: Graph;
  onSelect: (rid: string) => void;
  fill?: boolean;
}) {
  const uses: string[] = props.p.uses || [];
  const [views, setViews] = useState<Record<string, ViewData> | null>(uses.length ? null : {});
  // refetch when a used view gets a new instance or shape
  const key = uses
    .map((u) => {
      const v = props.graph.views.find((x) => x.id === u);
      return `${u}:${v?.latest_instance?.id ?? ""}:${v?.head.schema ?? ""}`;
    })
    .join("|");

  useEffect(() => {
    if (!uses.length) return setViews({});
    Promise.all(uses.map(loadViewData))
      .then((ds) => setViews(Object.fromEntries(ds.map(({ name, ...d }) => [name, d]))))
      .catch(() => setViews({}));
  }, [key]);

  const names = uses.map((u) => props.graph.views.find((v) => v.id === u)?.name || u);
  return (
    <div className={props.fill ? "visual-fill" : ""}>
      {names.length > 0 && <div className="muted small">also uses {names.map((n) => <code key={n}>{n} </code>)}</div>}
      {views === null ? (
        <div className="muted small">loading views…</div>
      ) : (
        <VisualFrame html={props.p.html} schema={props.schema} rows={props.rows} mode={props.mode}
                     view={props.view} views={views} onSelect={props.onSelect} fill={props.fill} />
      )}
    </div>
  );
}
