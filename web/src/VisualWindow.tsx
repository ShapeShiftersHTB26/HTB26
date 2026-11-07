import { useEffect, useRef, useState } from "react";
import { Graph, op, Proposal, ViewDetail } from "./api";
import Visual, { loadViewData } from "./Visual";

export type Win = { key: string; visualId: string; viewId: string; x: number; y: number; z: number };

// A floating, draggable, resizable window rendering one visual over its view's data (+ the views it uses).
export default function VisualWindow(props: {
  win: Win;
  graph: Graph;
  onClose: () => void;
  onFocus: () => void;
  onMove: (x: number, y: number) => void;
  onSelect: (rid: string) => void;
}) {
  const { win } = props;
  const [state, setState] = useState<{ p: Proposal; data: Awaited<ReturnType<typeof loadViewData>> } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  const v = props.graph.views.find((x) => x.id === win.viewId);
  const freshness = `${v?.latest_instance?.id ?? ""}:${v?.head.schema ?? ""}`;

  useEffect(() => {
    (async () => {
      const d = await op<ViewDetail>("get_view", { view_id: win.viewId });
      const p = d.proposals.visual.find((x) => x.id === win.visualId);
      if (!p) throw new Error("visual not found");
      setState({ p, data: await loadViewData(win.viewId) });
    })().catch((e) => setErr(e.message));
  }, [win.visualId, win.viewId, freshness]);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (drag.current) props.onMove(Math.max(0, e.clientX - drag.current.dx), Math.max(48, e.clientY - drag.current.dy));
    };
    const up = () => {
      drag.current = null;
      document.body.classList.remove("dragging");
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [props.onMove]);

  const title = v?.visuals?.find((x) => x.id === win.visualId)?.title || "visual";
  return (
    <div className="vwin" style={{ left: win.x, top: win.y, zIndex: win.z }} onMouseDown={props.onFocus}>
      <div
        className="vwin-head"
        onMouseDown={(e) => {
          drag.current = { dx: e.clientX - win.x, dy: e.clientY - win.y };
          document.body.classList.add("dragging");
          e.preventDefault();
        }}
      >
        <span className="vwin-title">
          ◧ {title} <span className="muted">· {v?.name ?? win.viewId}</span>
        </span>
        {state && (
          <span className={`vb ${state.data.mode === "instance" ? "data" : "pending"}`}>
            {state.data.mode === "instance" ? `${state.data.rows.length.toLocaleString()} rows` : "preview"}
          </span>
        )}
        {state && state.p.status !== "approved" && <span className="vb pending">{state.p.status}</span>}
        <button className="close" onMouseDown={(e) => e.stopPropagation()} onClick={props.onClose}>×</button>
      </div>
      <div className="vwin-body">
        {err && <div className="error pad">{err}</div>}
        {!state && !err && <div className="muted pad">loading…</div>}
        {state && (
          <Visual p={state.p} schema={state.data.schema} rows={state.data.rows} mode={state.data.mode}
                  view={{ id: win.viewId, name: v?.name ?? "" }} graph={props.graph} onSelect={props.onSelect} fill />
        )}
      </div>
    </div>
  );
}
