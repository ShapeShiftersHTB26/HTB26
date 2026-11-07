import { Background, Controls, Edge, Node, ReactFlow } from "@xyflow/react";
import { Graph } from "./api";

// Left-to-right layering by upstream depth (sources on the left).
function layout(graph: Graph): Node[] {
  const ups = new Map<string, string[]>();
  graph.edges.forEach((e) => ups.set(e.to, [...(ups.get(e.to) || []), e.from]));
  const depth = new Map<string, number>();
  const d = (id: string, seen = new Set<string>()): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const v = Math.max(-1, ...(ups.get(id) || []).map((u) => d(u, seen))) + 1;
    depth.set(id, v);
    return v;
  };
  const rows = new Map<number, number>();
  return graph.views.map((v) => {
    const col = d(v.id);
    const row = rows.get(col) || 0;
    rows.set(col, row + 1);
    return {
      id: v.id,
      position: { x: col * 280, y: row * 140 },
      data: { label: v.name },
      className: `vnode ${v.kind}`,
    };
  });
}

export default function Canvas(props: { graph: Graph; selected: string | null; onSelect: (id: string) => void }) {
  const nodes = layout(props.graph).map((n) => ({ ...n, selected: n.id === props.selected }));
  const edges: Edge[] = props.graph.edges.map((e) => ({
    id: `${e.from}->${e.to}`,
    source: e.from,
    target: e.to,
    animated: !!e.pending,
    style: e.pending ? { strokeDasharray: "6 4" } : undefined,
  }));
  return (
    <div className="canvas">
      <ReactFlow nodes={nodes} edges={edges} onNodeClick={(_, n) => props.onSelect(n.id)} fitView>
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
