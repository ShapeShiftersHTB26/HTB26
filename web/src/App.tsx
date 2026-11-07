import { useEffect, useState } from "react";
import { op, Graph } from "./api";
import Canvas from "./Canvas";

export default function App() {
  const [graph, setGraph] = useState<Graph>({ views: [], edges: [] });
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = () =>
      op<Graph>("get_graph")
        .then((g) => alive && (setGraph(g), setError(null)))
        .catch((e) => alive && setError(String(e.message || e)));
    tick();
    const t = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

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
      </main>
    </div>
  );
}
