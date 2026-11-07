import dagre from "@dagrejs/dagre";
import { Background, Controls, Edge, MarkerType, Node, NodeChange, ReactFlow, useReactFlow } from "@xyflow/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { columns } from "../api";
import { useThread } from "./ctx";
import { CanvasView, DatasetsNode, Note, NoteNode, QuestionNode, TableNode } from "./nodes";

const nodeTypes = { question: QuestionNode, note: NoteNode, table: TableNode, datasets: DatasetsNode };
const ACCENT = "#6a4cff";

// Rough rendered sizes, so dagre leaves room (nodes size themselves; generous estimates avoid overlaps).
function tableSize(v: CanvasView): [number, number] {
  const shape = v.pending_schemas[v.pending_schemas.length - 1] || v.head_schema;
  const ncols = columns(shape?.schema).length;
  const rows = v.instance ? Math.min(6, v.instance.row_count ?? 0) : Math.min(6, (shape?.preview || []).length);
  let h = 92 + (ncols ? 30 + rows * 26 : 0) + 22;
  if (v.answer) h += 60;
  if (v.pending_schemas.length) h += 86;
  h += v.pending_transforms.length * 96;
  if (v.visuals.length) h += 40;
  if (v.instance && v.member && v.kind !== "source") h += 110; // future row block
  if (v.instance && v.answer) h += 44;
  return [Math.min(620, Math.max(380, ncols * 110)), h];
}

/** The thread's working graph: question → tables → their inputs → sources, notes beside, "?" where data is missing. */
export default function ResearchCanvas() {
  const { t, focus, setFocus } = useThread();
  const c = t.canvas;
  const flow = useReactFlow();
  // measured node sizes (react-flow reports them after render); layout uses them over the estimates
  const [measured, setMeasured] = useState<Record<string, [number, number]>>({});
  const onNodesChange = (changes: NodeChange[]) => {
    const upd: Record<string, [number, number]> = {};
    changes.forEach((ch) => {
      if (ch.type === "dimensions" && ch.dimensions) {
        const old = measured[ch.id];
        const wh: [number, number] = [ch.dimensions.width, ch.dimensions.height];
        if (!old || Math.abs(old[1] - wh[1]) > 4 || Math.abs(old[0] - wh[0]) > 4) upd[ch.id] = wh;
      }
    });
    if (Object.keys(upd).length) setMeasured((m) => ({ ...m, ...upd }));
  };

  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const size = new Map<string, [number, number]>();
    const add = (n: Node, wh: [number, number]) => (nodes.push(n), size.set(n.id, [wh[0], measured[n.id]?.[1] ?? wh[1]]));
    const link = (a: string, b: string, cls = "", pending = false) =>
      edges.push({
        id: `${a}->${b}`,
        source: a,
        target: b,
        className: cls,
        animated: pending,
        style: pending ? { strokeDasharray: "6 4", stroke: ACCENT } : undefined,
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      });

    add({ id: "question", type: "question", data: { text: t.intent.text }, position: { x: 0, y: 0 } }, [420, 90]);
    const read = new Set(c.edges.map((e) => e.to));
    c.nodes.forEach((v) => add({ id: v.id, type: "table", data: { view: v }, position: { x: 0, y: 0 } }, tableSize(v)));
    c.edges.forEach((e) => link(e.from, e.to, "", e.pending));
    // top-level tables hang off the question
    c.nodes.filter((v) => !read.has(v.id) && v.kind !== "source").forEach((v) => link("question", v.id));
    c.notes.forEach((n: Note) => {
      const lines = Math.ceil(n.text.length / 38);
      add({ id: `note:${n.id}`, type: "note", data: { note: n }, position: { x: 0, y: 0 } }, [280, 46 + lines * 20]);
      if (n.about && c.nodes.some((v) => v.id === n.about)) link(`note:${n.id}`, n.about, "edge-note");
      else link("question", `note:${n.id}`, "edge-note");
    });
    // the deepest derived table that has no way to be computed yet: where data still has to come in
    const open = c.nodes.filter((v) => v.kind !== "source" && !v.head_transform && !v.pending_transforms.length);
    const at = open[open.length - 1] || c.nodes.filter((v) => v.kind !== "source").slice(-1)[0];
    // a source loaded for this thread that no step reads yet: show it as the data that table will use
    c.nodes.filter((v) => v.kind === "source" && !read.has(v.id)).forEach((v) => at && link(at.id, v.id, "edge-data", true));
    if (c.open_datasets.length) {
      // the "?" with the dataset choice hangs off that table
      add({ id: "datasets", type: "datasets", data: { ids: c.open_datasets }, position: { x: 0, y: 0 } },
          [Math.min(900, 300 * c.open_datasets.length + 20), 260]);
      link(at ? at.id : "question", "datasets", "", true);
    }

    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: "TB", nodesep: 40, ranksep: 70 });
    g.setDefaultEdgeLabel(() => ({}));
    nodes.forEach((n) => {
      const [w, h] = size.get(n.id)!;
      g.setNode(n.id, { width: w, height: h });
    });
    edges.forEach((e) => g.setEdge(e.source, e.target, { weight: e.className === "edge-note" ? 1 : 3 }));
    dagre.layout(g);
    nodes.forEach((n) => {
      const p = g.node(n.id);
      n.position = { x: p.x - p.width / 2, y: p.y - p.height / 2 };
      n.style = { width: p.width };
    });
    return { nodes, edges };
  }, [t, measured]);

  // pan to the focused node when focus changes (from a click, the chat, or the agent)
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (!focus || focus === last.current) return;
    const n = nodes.find((x) => x.id === focus);
    if (!n) return;
    last.current = focus;
    const w = (n.style?.width as number) || 300;
    flow.setCenter(n.position.x + w / 2, n.position.y + 160, { zoom: Math.max(flow.getZoom(), 0.85), duration: 500 });
  }, [focus, nodes]);

  // fit everything once nodes first appear / when a node is added
  const count = useRef(0);
  useEffect(() => {
    if (nodes.length !== count.current && !focus) setTimeout(() => flow.fitView({ duration: 400, maxZoom: 1 }), 50);
    count.current = nodes.length;
  }, [nodes.length]);

  return (
    <div className="research-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        nodesDraggable={false}
        nodesConnectable={false}
        minZoom={0.2}
        fitView
        fitViewOptions={{ maxZoom: 1 }}
        onNodeClick={(_, n) => setFocus(n.id === "question" ? null : n.id.startsWith("note:") ? null : n.id)}
        onPaneClick={() => setFocus(null)}
      >
        <Background />
        <Controls showInteractive={false} position="bottom-left" />
      </ReactFlow>
    </div>
  );
}
