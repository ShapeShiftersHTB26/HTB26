import dagre from "@dagrejs/dagre";
import { Background, Controls, Edge, MarkerType, Node, ReactFlow } from "@xyflow/react";
import { Graph, View } from "./api";

export type CanvasTarget = { viewId: string; tab: "schema" | "visual" | "transform" | "data" | null };

const SIZE = { view: [210, 64], data: [150, 44], visual: [150, 44] } as const;
const COLORS = { muted: "#9a9aa0", accent: "#6a4cff", ok: "#1f9d55" };

// Graph of views (flow via transforms), their data instances and their visuals; laid out top -> bottom.
// TODO (when the graph grows): collapse edges that span many ranks into stubs / bundles.
function build(graph: Graph, selected: string | null): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const byId = new Map(graph.views.map((v) => [v.id, v]));

  graph.views.forEach((v: View) => {
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

    (v.visuals || []).forEach((vis) => {
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
      edges.push({ id: `e:v-x:${vis.id}`, source: `v:${v.id}`, target: `x:${vis.id}`, className: "edge-attach" });
      vis.uses.forEach((u) => {
        if (!byId.has(u)) return;
        edges.push({
          id: `e:u:${u}-${vis.id}`,
          source: `v:${u}`,
          target: `x:${vis.id}`,
          label: "uses",
          className: "edge-uses",
          style: { strokeDasharray: "4 4", stroke: COLORS.accent },
          markerEnd: { type: MarkerType.ArrowClosed, color: COLORS.accent },
        });
      });
    });
  });

  graph.edges.forEach((e) => {
    if (!byId.has(e.from) || !byId.has(e.to)) return;
    edges.push({
      id: `e:t:${e.from}-${e.to}`,
      source: `v:${e.from}`,
      target: `v:${e.to}`,
      label: e.kind || "",
      animated: !!e.pending,
      className: `edge-transform ${e.kind || ""}`,
      style: {
        strokeWidth: 2,
        stroke: e.kind?.startsWith("agent") ? COLORS.accent : "#444",
        strokeDasharray: e.pending ? "6 4" : undefined,
      },
      markerEnd: { type: MarkerType.ArrowClosed },
    });
  });

  // dagre layered layout, top -> bottom
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 36, ranksep: 56, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  nodes.forEach((n) => {
    const kind = n.id.startsWith("v:") ? "view" : n.id.startsWith("d:") ? "data" : "visual";
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

export default function Canvas(props: { graph: Graph; selected: string | null; onSelect: (t: CanvasTarget) => void }) {
  const { nodes, edges } = build(props.graph, props.selected);
  return (
    <div className="canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        nodesDraggable={false}
        onNodeClick={(_, n) => {
          const [kind, id] = [n.id.slice(0, 1), n.id.slice(2)];
          if (kind === "v") props.onSelect({ viewId: id, tab: null });
          if (kind === "d") props.onSelect({ viewId: id, tab: "data" });
          if (kind === "x") {
            const owner = props.graph.views.find((v) => v.visuals?.some((x) => x.id === id));
            if (owner) props.onSelect({ viewId: owner.id, tab: "visual" });
          }
        }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
