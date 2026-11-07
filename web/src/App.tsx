import { useEffect, useState } from "react";
import { op, Graph } from "./api";
import Canvas from "./Canvas";
import ViewPanel from "./ViewPanel";

export default function App() {
  const [graph, setGraph] = useState<Graph>({ views: [], edges: [] });
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const poll = () =>
      op<Graph>("get_graph")
        .then((g) => {
          if (!alive) return;
          setGraph(g);
          setError(null);
          setTick((t) => t + 1);
        })
        .catch((e) => alive && setError(String(e.message || e)));
    poll();
    const t = setInterval(poll, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // auto-select the newest view when nothing is selected
  useEffect(() => {
    if (!selected && graph.views.length) setSelected(graph.views[graph.views.length - 1].id);
    if (selected && !graph.views.find((v) => v.id === selected)) setSelected(null);
  }, [graph, selected]);

  return (
    <div className="app">
      <header>
        <strong>Backtrace</strong>
        <span className="muted">{graph.views.length} views</span>
        {error && <span className="error">api: {error}</span>}
      </header>
      <main>
        <Canvas graph={graph} selected={selected} onSelect={setSelected} />
        {graph.views.length === 0 && (
          <div className="empty">No views yet — ask a question in Claude Code (run from agent/).</div>
        )}
        {selected && <ViewPanel viewId={selected} tick={tick} onClose={() => setSelected(null)} />}
      </main>
    </div>
  );
}
