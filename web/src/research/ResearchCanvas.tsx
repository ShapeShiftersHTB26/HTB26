import dagre from "@dagrejs/dagre";
import { Background, Controls, Edge, MarkerType, Node, NodeChange, ReactFlow, useReactFlow } from "@xyflow/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { columns, Thread } from "../api";
import { useThread } from "./ctx";
import { CanvasView, DatasetsNode, Note, NoteNode, QuestionNode, TableNode } from "./nodes";

const nodeTypes = { question: QuestionNode, note: NoteNode, table: TableNode, datasets: DatasetsNode };
const ACCENT = "#6a4cff";
// one colour per question; tables used by several questions carry several
export const QCOLORS = ["#6a4cff", "#e8590c", "#0c8599", "#c2255c", "#5c940d", "#1971c2", "#9c36b5"];

/** Per question: every table in its chain (its own tables plus everything upstream of them). */
export function questionChains(c: Thread["canvas"]): Map<string, Set<string>> {
  const reads = new Map<string, string[]>();
  c.edges.forEach((e) => reads.set(e.from, [...(reads.get(e.from) || []), e.to]));
  const out = new Map<string, Set<string>>();
  c.questions.forEach((q) => {
    const seen = new Set<string>();
    const todo = [...q.views];
    while (todo.length) {
      const v = todo.pop()!;
      if (seen.has(v)) continue;
      seen.add(v);
      todo.push(...(reads.get(v) || []));
    }
    out.set(q.id, seen);
  });
  return out;
}

// Rough rendered sizes, so dagre leaves room before nodes are measured.
function tableSize(v: CanvasView, compact: boolean): [number, number] {
  const shape = v.pending_schemas[v.pending_schemas.length - 1] || v.head_schema;
  // a proposed change shows old and new columns side by side, so size for both
  const ncols = new Set([...columns(v.head_schema?.schema), ...columns(shape?.schema)].map((c) => c.name)).size;
  if (compact) return [340, 92];
  const rows = v.instance ? Math.min(6, v.instance.row_count ?? 0) : Math.min(6, (shape?.preview || []).length);
  let h = 100 + (ncols ? 34 + rows * 27 + 22 : 0);
  if (shape?.scope?.length) h += 32;
  if (v.pending_schemas.length) h += 110;
  h += v.pending_transforms.length * 110;
  h += v.visuals.filter((x) => x.status === "pending").length * 100;
  if (v.visuals.some((x) => x.status !== "pending") || (v.instance && v.kind !== "source")) h += 42;
  if (v.instance && v.member && v.kind !== "source") h += 96;
  if (v.instance || v.head_transform) h += 44;
  return [Math.min(620, Math.max(380, ncols * 110)), h];
}

/** The workspace graph: questions on top, working tables in the middle, sources on the data shelf at the bottom.
 * Tables are compact unless focused, pending, or the answer to the selected question; the selected question's
 * chain is highlighted and the rest fades. */
export default function ResearchCanvas() {
  const { t, focus, setFocus, activeQ, setActiveQ, highlight, camera, readOnly } = useThread();
  const c = t.canvas;
  const flow = useReactFlow();
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

  const chains = useMemo(() => questionChains(c), [t]);
  const { nodes, edges, size } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const size = new Map<string, [number, number]>();
    const active = activeQ ? chains.get(activeQ) : null;
    const dim = (id: string) => (active && !active.has(id) ? "faded" : "");
    const add = (n: Node, wh: [number, number]) => (nodes.push(n), size.set(n.id, [wh[0], measured[n.id]?.[1] ?? wh[1]]));
    const link = (a: string, b: string, cls = "", pending = false, color?: string) =>
      edges.push({
        id: `${a}->${b}`,
        source: a,
        target: b,
        className: cls,
        animated: pending,
        style: { ...(pending ? { strokeDasharray: "6 4", stroke: ACCENT } : {}), ...(color ? { stroke: color, strokeWidth: 2 } : {}) },
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, ...(color ? { color } : {}) },
      });

    const qcolor = new Map(c.questions.map((q, i) => [q.id, QCOLORS[i % QCOLORS.length]]));
    const results = new Set(c.questions.filter((q) => !activeQ || q.id === activeQ).map((q) => q.result_view_id));
    c.questions.forEach((q, i) =>
      add({ id: `q:${q.id}`, type: "question", className: active && q.id !== activeQ ? "faded" : "",
            data: { q, n: i + 1, color: qcolor.get(q.id), active: q.id === activeQ }, position: { x: 0, y: 0 } },
          q.summary ? [480, 96 + Math.ceil(q.summary.length / 60) * 20 + 30] : [400, 96]));
    c.nodes.forEach((v) => {
      const pending = v.pending_schemas.length + v.pending_transforms.length + v.visuals.filter((x) => x.status === "pending").length;
      const compact = focus !== v.id && !pending && !results.has(v.id) && !!v.head_schema;
      const colors = c.questions.filter((q) => chains.get(q.id)?.has(v.id)).map((q) => qcolor.get(q.id)!);
      add({ id: v.id, type: "table", className: dim(v.id), data: { view: v, compact, colors }, position: { x: 0, y: 0 } },
          tableSize(v, compact));
    });
    c.edges.forEach((e) => link(e.from, e.to, active && !(active.has(e.from) && active.has(e.to)) ? "faded" : "", e.pending));
    // each question points at its own top tables (the ones no other table of that question reads)
    const readBy = new Set(c.edges.map((e) => `${e.from}>${e.to}`));
    c.questions.forEach((q) => {
      const own = q.views.filter((v) => c.nodes.some((n) => n.id === v && n.kind !== "source"));
      own.filter((v) => !own.some((o) => readBy.has(`${o}>${v}`)))
        .forEach((v) => link(`q:${q.id}`, v, active && q.id !== activeQ ? "faded" : "", false, qcolor.get(q.id)));
    });
    const firstQ = c.questions[0] ? `q:${c.questions[0].id}` : null;
    c.notes.forEach((n: Note) => {
      const lines = Math.ceil(n.text.length / 38);
      add({ id: `note:${n.id}`, type: "note", className: n.about ? dim(n.about) : "", data: { note: n }, position: { x: 0, y: 0 } },
          [280, 46 + lines * 20]);
      if (n.about && c.nodes.some((v) => v.id === n.about)) link(`note:${n.id}`, n.about, "edge-note");
      else if (firstQ) link(firstQ, `note:${n.id}`, "edge-note");
    });
    const read = new Set(c.edges.map((e) => e.to));
    const open = c.nodes.filter((v) => v.kind !== "source" && !v.head_transform && !v.pending_transforms.length);
    const at = open[open.length - 1] || c.nodes.filter((v) => v.kind !== "source").slice(-1)[0];
    c.nodes.filter((v) => v.kind === "source" && !read.has(v.id)).forEach((v) => at && link(at.id, v.id, "edge-data", true));
    if (c.open_datasets.length) {
      add({ id: "datasets", type: "datasets", data: { ids: c.open_datasets }, position: { x: 0, y: 0 } },
          [Math.min(900, 300 * c.open_datasets.length + 20), 260]);
      const from = at ? at.id : firstQ;
      if (from) link(from, "datasets", "", true);
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
    // bands: questions along the top, sources on the data shelf at the bottom (dagre alone ranks by edges)
    const wh = (n: Node) => size.get(n.id)!;
    const band = (sel: Node[], y: number) => {
      let right = -Infinity;
      sel.sort((a, b) => a.position.x - b.position.x).forEach((n) => {
        n.position = { x: Math.max(n.position.x, right + 40), y };
        right = n.position.x + wh(n)[0];
      });
    };
    const qs = nodes.filter((n) => n.type === "question");
    const srcs = nodes.filter((n) => n.type === "table" && (n.data.view as CanvasView).kind === "source");
    const middle = nodes.filter((n) => !qs.includes(n) && !srcs.includes(n));
    const qh = Math.max(96, ...qs.map((n) => wh(n)[1]));
    const top = Math.min(...middle.map((n) => n.position.y), 0) - qh - 70;
    band(qs, top);
    if (srcs.length) band(srcs, Math.max(...middle.map((n) => n.position.y + wh(n)[1]), top + 96) + 90);
    return { nodes, edges, size };
  }, [t, measured, focus, activeQ, chains]);

  // replay: the node this step changed flashes (key restarts the animation on every step)
  const shown = useMemo(
    () => (highlight ? nodes.map((n) => (n.id === highlight.id
      ? { ...n, className: `${n.className || ""} rp-flash rp-flash-${highlight.tone} rp-k${highlight.key % 2}` } : n)) : nodes),
    [nodes, highlight],
  );

  // The camera. Aimed from OUR layout (dagre positions + measured or estimated sizes), never from React Flow's
  // internal measurements, which lag a frame behind when nodes appear or resize (that left the view empty).
  // The floating chat covers the canvas's right side, so targets are centred in the part left of it.
  // A target is re-aimed while the layout settles (sizes arrive after the first render) for SETTLE_MS, then the
  // view is left alone so it never fights the user's own panning.
  const SETTLE_MS = 2500;
  const wrap = useRef<HTMLDivElement>(null);
  const rectOf = (ids: string[]) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    ids.forEach((id) => {
      const n = nodes.find((x) => x.id === id);
      const wh = size.get(id);
      if (!n || !wh) return;
      const w = (n.style?.width as number) || wh[0];
      const h = measured[id]?.[1] ?? wh[1];
      x0 = Math.min(x0, n.position.x); y0 = Math.min(y0, n.position.y);
      x1 = Math.max(x1, n.position.x + w); y1 = Math.max(y1, n.position.y + h);
    });
    return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };
  const look = (ids: string[], maxZoom: number, pad = 48) => {
    const r = rectOf(ids);
    const el = wrap.current;
    if (!r || !el) return;
    const box = el.getBoundingClientRect();
    let W = box.width;
    const chat = document.querySelector(".chatwin")?.getBoundingClientRect();
    if (chat && chat.left > box.left + box.width * 0.4 && chat.left < box.right) W = chat.left - box.left - 8;
    const H = box.height;
    const zoom = Math.max(0.15, Math.min(maxZoom, (W - 2 * pad) / r.w, (H - 2 * pad) / r.h));
    // centred; a target taller than the view is shown from its top
    const y = r.h * zoom > H - 2 * pad ? pad - r.y * zoom : H / 2 - (r.y + r.h / 2) * zoom;
    flow.setViewport({ x: W / 2 - (r.x + r.w / 2) * zoom, y, zoom }, { duration: 500 });
  };
  const sig = (ids: string[]) =>
    ids.map((id) => nodes.find((n) => n.id === id)).filter(Boolean)
      .map((n) => `${n!.id}@${Math.round(n!.position.x)},${Math.round(n!.position.y)},${n!.style?.width},${measured[n!.id]?.[1] ?? ""}`)
      .join("|");

  // what to look at: a focus (click, agent, replay step) wins over a framing request
  const target: { ids: string[]; maxZoom: number; key: string } | null = focus
    ? { ids: [focus], maxZoom: focus.startsWith("q:") ? 1.15 : 1, key: `f:${focus}` }
    : camera
      ? { ids: (camera.kind === "all" ? nodes.map((n) => n.id)
            : camera.kind === "chain" ? [`q:${camera.q}`, ...(chains.get(camera.q || "") ?? [])] : camera.ids ?? [])
            .filter((id) => nodes.some((n) => n.id === id)),
          maxZoom: camera.kind === "all" ? 1 : 0.95, key: `c:${camera.key}` }
      : null;
  const tSig = target ? sig(target.ids) : "";
  const aim = useRef<{ key: string; at: number; sig: string }>({ key: "", at: 0, sig: "" });
  const pending = useRef(0);
  useEffect(() => {
    if (!target || !target.ids.length || !tSig) return;
    if (aim.current.key !== target.key) aim.current = { key: target.key, at: Date.now(), sig: "" };
    else if (tSig === aim.current.sig || Date.now() - aim.current.at > SETTLE_MS) return;
    aim.current.sig = tSig;
    const t = target;
    cancelAnimationFrame(pending.current); // only the newest aim may land (a stale one would undo it)
    pending.current = requestAnimationFrame(() => look(t.ids, t.maxZoom));
  }, [target?.key, tSig]);

  const count = useRef(0);
  useEffect(() => {
    const aiming = !!target && Date.now() - aim.current.at <= SETTLE_MS;
    if (nodes.length !== count.current && !focus && !aiming && !readOnly) {
      cancelAnimationFrame(pending.current);
      pending.current = requestAnimationFrame(() => look(nodes.map((n) => n.id), 1));
    }
    count.current = nodes.length;
  }, [nodes.length]);

  return (
    <div className="research-canvas" ref={wrap}>
      <ReactFlow
        nodes={shown}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        nodesDraggable={false}
        nodesConnectable={false}
        minZoom={0.2}
        fitView
        fitViewOptions={{ maxZoom: 1 }}
        onNodeClick={(_, n) => {
          if (n.id.startsWith("q:")) {
            const id = n.id.slice(2);
            setActiveQ(activeQ === id ? null : id);
            if (activeQ !== id) setFocus(n.id);
          } else if (!n.id.startsWith("note:")) setFocus(n.id);
        }}
        onPaneClick={() => (setFocus(null), setActiveQ(null))}
      >
        <Background />
        <Controls showInteractive={false} position="bottom-left" />
      </ReactFlow>
    </div>
  );
}
