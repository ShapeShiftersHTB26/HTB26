import { useEffect, useState } from "react";
import { op, Graph } from "./api";
import Canvas, { CanvasTarget, Lens } from "./Canvas";
import IntentPanel from "./IntentPanel";
import TraceDrawer from "./TraceDrawer";
import ViewPanel, { Tab } from "./ViewPanel";
import VisualWindow, { Win } from "./VisualWindow";

export default function App() {
  const [graph, setGraph] = useState<Graph>({ views: [], edges: [], intents: [] });
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [intent, setIntent] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [traceRid, setTraceRid] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("schema");
  const [lens, setLens] = useState<Lens>("outcome");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [wins, setWins] = useState<Win[]>([]);
  const openVisual = (visualId: string, viewId: string) =>
    setWins((ws) => {
      const z = Math.max(20, ...ws.map((w) => w.z)) + 1;
      const existing = ws.find((w) => w.visualId === visualId);
      if (existing) return ws.map((w) => (w === existing ? { ...w, z } : w));
      const n = ws.length % 6;
      return [...ws, { key: `${visualId}:${Date.now()}`, visualId, viewId, x: 80 + n * 36, y: 90 + n * 36, z }];
    });
  const focusWin = (key: string) =>
    setWins((ws) => {
      const z = Math.max(20, ...ws.map((w) => w.z));
      return ws.map((w) => (w.key === key && w.z < z ? { ...w, z: z + 1 } : w));
    });

  const open = (t: CanvasTarget) => {
    if (t.type === "visual") return openVisual(t.visualId, t.viewId);
    if (t.type === "intent") {
      setIntent(t.intentId);
      setSelected(null);
    } else {
      setSelected(t.viewId);
      setIntent(null);
      if (t.tab) setTab(t.tab);
    }
  };
  const toggleExpand = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

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

  useEffect(() => {
    if (selected && !graph.views.find((v) => v.id === selected)) setSelected(null);
  }, [graph, selected]);

  return (
    <div className="app">
      <header>
        <strong>Backtrace</strong>
        <span className="muted">
          {graph.views.length} views · {(graph.intents || []).length} intents
        </span>
        <div className="lens">
          {(["outcome", "detail"] as Lens[]).map((l) => (
            <button key={l} className={lens === l ? "active" : ""} onClick={() => setLens(l)}>
              {l === "outcome" ? "Outcomes" : "Detail"}
            </button>
          ))}
        </div>
        {error && <span className="error">api: {error}</span>}
      </header>
      <main>
        <Canvas graph={graph} selected={selected} lens={lens} expanded={expanded} onSelect={open} />
        {graph.views.length === 0 && (
          <div className="empty">No views yet — ask a question in Claude Code (run from agent/).</div>
        )}
        {selected && (
          <ViewPanel viewId={selected} tick={tick} graph={graph} onClose={() => setSelected(null)}
                     onSelectRecord={setTraceRid} tab={tab} onTab={setTab} onOpenVisual={openVisual} />
        )}
        {intent && (
          <IntentPanel intentId={intent} tick={tick} expanded={expanded.has(intent)}
                       onToggleExpand={() => toggleExpand(intent)} onOpen={open} onClose={() => setIntent(null)} />
        )}
        {wins.map((w) => (
          <VisualWindow key={w.key} win={w} graph={graph} onSelect={setTraceRid} onFocus={() => focusWin(w.key)}
                        onClose={() => setWins((ws) => ws.filter((x) => x.key !== w.key))}
                        onMove={(x, y) => setWins((ws) => ws.map((o) => (o.key === w.key ? { ...o, x, y } : o)))} />
        ))}
        {traceRid && (
          <TraceDrawer rid={traceRid} names={new Map(graph.views.map((v) => [v.id, v.name]))}
                       onClose={() => setTraceRid(null)} onSelect={setTraceRid}
                       onOpenView={(id) => open({ type: "view", viewId: id, tab: null })} />
        )}
      </main>
    </div>
  );
}
