import dagre from "@dagrejs/dagre";
import { Background, Controls, Edge, MarkerType, Node, ReactFlow } from "@xyflow/react";
import { Graph, Intent, View } from "./api";

export type Lens = "outcome" | "detail";
export type CanvasTarget =
  | { type: "view"; viewId: string; tab: "schema" | "visual" | "transform" | "data" | null }
  | { type: "intent"; intentId: string }
  | { type: "visual"; visualId: string; viewId: string };

const SIZE = { view: [210, 64], data: [150, 44], visual: [150, 44], intent: [240, 74] } as const;
const ACCENT = "#6a4cff";
const short = (s: string, n = 70) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// One graph of views, data, visuals and intents; laid out top -> bottom.
// Outcome lens: each intent collapses its path (member views/transforms) into one node: inputs -> intent -> result.
// Detail lens (or an expanded intent): the full path.
// TODO (when the graph grows): collapse edges that span many ranks into stubs / bundles.
function build(graph: Graph, selected: string | null, lens: Lens, expanded: Set<string>) {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const views = new Map(graph.views.map((v) => [v.id, v]));
  const intents = graph.intents || [];
  const collapsed = new Map(
    intents.filter((q) => lens === "outcome" && !expanded.has(q.id)).map((q) => [q.id, q] as [string, Intent]),
  );
  const hiddenBy = new Map<string, string>(); // view id -> collapsed intent hiding it
  collapsed.forEach((q) =>
    q.members.forEach((m) => {
      if (!(q.result_kind === "view" && q.result_current === m)) hiddenBy.set(m, q.id);
    }),
  );
  const visible = (vid: string) => views.has(vid) && !hiddenBy.has(vid);
  const nodeOfView = (vid: string) => (visible(vid) ? `v:${vid}` : hiddenBy.has(vid) ? `q:${hiddenBy.get(vid)}` : null);
  const resultVisuals = new Set([...collapsed.values()].filter((q) => q.result_kind === "visual").map((q) => q.result_current));

  graph.views.forEach((v: View) => {
    if (!visible(v.id)) return;
    const pending = v.pending.schema + v.pending.transform + v.pending.visual;
    const empty = !v.head.schema && pending === 0;
    nodes.push({
      id: `v:${v.id}`,
      type: v.kind === "source" ? "input" : "default",
      selected: v.id === selected,
      className: `gnode view ${v.kind} ${empty ? "empty" : ""}`,
      data: {
        label: (
          <div>
            <div className="vname">{v.name}</div>
            <div className="vbadges">
              {v.kind === "source" && <span className="vb">source</span>}
              {!v.head.schema && !empty && <span className="vb draft">draft</span>}
              {empty && <span className="vb">empty</span>}
              {pending > 0 && <span className="vb pending">{pending} pending</span>}
            </div>
          </div>
        ),
      },
      position: { x: 0, y: 0 },
    });
    if (v.latest_instance) {
      const older = (v.instance_count || 1) - 1;
      nodes.push({
        id: `d:${v.id}`,
        type: "output",
        className: "gnode data",
        data: {
          label: (
            <div>
              <div>▤ {v.latest_instance.row_count.toLocaleString()} rows</div>
              <div className="vbadges">
                {v.latest_instance.model && <span className="vb draft">agentic</span>}
                {older > 0 && <span className="vb">+{older} older</span>}
              </div>
            </div>
          ),
        },
        position: { x: 0, y: 0 },
      });
      edges.push({ id: `e:v-d:${v.id}`, source: `v:${v.id}`, target: `d:${v.id}`, className: "edge-attach" });
    }
  });

  // visuals: hang off their view, or off their collapsed intent (as its result); hidden otherwise
  graph.views.forEach((v) =>
    (v.visuals || []).forEach((vis) => {
      const owner = vis.intent_id && collapsed.get(vis.intent_id);
      if (owner && !resultVisuals.has(vis.id)) return; // a non-result step inside a collapsed intent
      if (!owner && !visible(v.id)) return;
      nodes.push({
        id: `x:${vis.id}`,
        type: "output",
        className: `gnode visual ${vis.status}`,
        data: {
          label: (
            <div>
              <div>◧ {vis.title || "visual"}</div>
              {vis.status === "pending" && <div className="vbadges"><span className="vb pending">pending</span></div>}
            </div>
          ),
        },
        position: { x: 0, y: 0 },
      });
      const src = owner ? `q:${owner.id}` : `v:${v.id}`;
      edges.push({ id: `e:x:${vis.id}`, source: src, target: `x:${vis.id}`,
                   className: owner ? "edge-result" : "edge-attach",
                   markerEnd: owner ? { type: MarkerType.ArrowClosed, color: ACCENT } : undefined });
      if (!owner)
        vis.uses.forEach((u) => {
          const from = nodeOfView(u);
          if (from) edges.push({ id: `e:u:${u}-${vis.id}`, source: from, target: `x:${vis.id}`, label: "uses",
                                 className: "edge-uses", style: { strokeDasharray: "4 4", stroke: ACCENT } });
        });
    }),
  );

  // transforms between visible views
  graph.edges.forEach((e) => {
    if (!visible(e.from) || !visible(e.to)) return;
    edges.push({
      id: `e:t:${e.from}-${e.to}`,
      source: `v:${e.from}`,
      target: `v:${e.to}`,
      label: e.kind || "",
      animated: !!e.pending,
      className: "edge-transform",
      style: { strokeWidth: 2, stroke: e.kind?.startsWith("agent") ? ACCENT : "#444",
               strokeDasharray: e.pending ? "6 4" : undefined },
      markerEnd: { type: MarkerType.ArrowClosed },
    });
  });

  // intents (outcome lens): collapsed = inputs -> intent -> result; expanded = intent groups its members
  if (lens === "outcome")
    intents.forEach((q) => {
      const isCollapsed = collapsed.has(q.id);
      nodes.push({
        id: `q:${q.id}`,
        className: `gnode intent ${q.status} ${isCollapsed ? "" : "expanded"}`,
        data: {
          label: (
            <div>
              <div className="qtext">“{short(q.text)}”</div>
              <div className="vbadges">
                <span className={`vb ${q.status === "open" ? "pending" : "data"}`}>{q.status}</span>
                <span className="vb">{q.mode}</span>
                <span className="vb">{q.steps} steps {isCollapsed ? "▸" : "▾"}</span>
              </div>
            </div>
          ),
        },
        position: { x: 0, y: 0 },
      });
      const seen = new Set<string>();
      q.inputs.forEach((i) => {
        const from = nodeOfView(i);
        if (!from || from === `q:${q.id}` || seen.has(from)) return;
        seen.add(from);
        edges.push({ id: `e:qi:${q.id}-${i}`, source: from, target: `q:${q.id}`, className: "edge-intent",
                     style: { stroke: ACCENT, strokeWidth: 2 }, markerEnd: { type: MarkerType.ArrowClosed, color: ACCENT } });
      });
      if (isCollapsed && q.result_kind === "view" && q.result_current && visible(q.result_current))
        edges.push({ id: `e:qr:${q.id}`, source: `q:${q.id}`, target: `v:${q.result_current}`, className: "edge-result",
                     markerEnd: { type: MarkerType.ArrowClosed, color: ACCENT } });
      if (!isCollapsed)
        q.members.forEach((m) => {
          if (visible(m))
            edges.push({ id: `e:qm:${q.id}-${m}`, source: `q:${q.id}`, target: `v:${m}`, className: "edge-group",
                         style: { strokeDasharray: "2 5", stroke: ACCENT } });
        });
    });

  // dagre layered layout, top -> bottom
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 36, ranksep: 56, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  nodes.forEach((n) => {
    const kind = ({ v: "view", d: "data", x: "visual", q: "intent" } as const)[n.id[0] as "v" | "d" | "x" | "q"];
    const [w, h] = SIZE[kind];
    g.setNode(n.id, { width: w, height: h });
  });
  edges.forEach((e) => g.setEdge(e.source, e.target, { weight: e.className?.includes("transform") ? 3 : 1 }));
  dagre.layout(g);
  nodes.forEach((n) => {
    const p = g.node(n.id);
    n.position = { x: p.x - p.width / 2, y: p.y - p.height / 2 };
    n.style = { width: p.width };
  });
  return { nodes, edges };
}

export default function Canvas(props: {
  graph: Graph;
  selected: string | null;
  lens: Lens;
  expanded: Set<string>;
  onSelect: (t: CanvasTarget) => void;
}) {
  const { nodes, edges } = build(props.graph, props.selected, props.lens, props.expanded);
  return (
    <div className="canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        nodesDraggable={false}
        onNodeClick={(_, n) => {
          const [kind, id] = [n.id[0], n.id.slice(2)];
          if (kind === "v") props.onSelect({ type: "view", viewId: id, tab: null });
          if (kind === "d") props.onSelect({ type: "view", viewId: id, tab: "data" });
          if (kind === "q") props.onSelect({ type: "intent", intentId: id });
          if (kind === "x") {
            const owner = props.graph.views.find((v) => v.visuals?.some((x) => x.id === id));
            if (owner) props.onSelect({ type: "visual", visualId: id, viewId: owner.id });
          }
        }}
      >
        <Background />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
    </div>
  );
}
