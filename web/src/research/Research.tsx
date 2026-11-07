import { ReactNode, useEffect, useState } from "react";
import { Graph, op } from "../api";
import TraceDrawer from "../TraceDrawer";
import VisualWindow, { Win } from "../VisualWindow";
import Landing from "./Landing";
import ThreadView from "./ThreadView";

/** The Research tab: question-first chat threads. The canvas lives on the Graph tab. */
export default function Research(props: { nav: ReactNode; hidden: boolean; threadId: string | null }) {
  const [graph, setGraph] = useState<Graph>({ views: [], edges: [], intents: [] });
  const [wins, setWins] = useState<Win[]>([]);
  const [traceRid, setTraceRid] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = () => op<Graph>("get_graph").then((g) => alive && setGraph(g)).catch(() => {});
    poll();
    const h = setInterval(poll, 2500);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, []);

  const openVisual = (visualId: string, viewId: string) =>
    setWins((ws) => {
      const z = Math.max(20, ...ws.map((w) => w.z)) + 1;
      const existing = ws.find((w) => w.visualId === visualId);
      if (existing) return ws.map((w) => (w === existing ? { ...w, z } : w));
      const n = ws.length % 6;
      return [...ws, { key: `${visualId}:${Date.now()}`, visualId, viewId, x: 340 + n * 36, y: 90 + n * 36, z }];
    });
  const go = (id: string | null) => (window.location.hash = id ? `#/t/${id}` : "#/");
  const threads = (graph.intents || [])
    .filter((q) => !q.parent_id)
    .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));

  return (
    <div className="app research" style={props.hidden ? { display: "none" } : undefined}>
      <header>
        <strong>Backtrace</strong>
        {props.nav}
      </header>
      <main>
        <aside className="threads">
          <button className={`new ${props.threadId ? "" : "active"}`} onClick={() => go(null)}>+ New research</button>
          <div className="label">Your research</div>
          {threads.map((q) => {
            const busy = q.agent_status === "queued" || q.agent_status === "working";
            return (
              <a key={q.id} className={q.id === props.threadId ? "active" : ""} onClick={() => go(q.id)} title={q.text}>
                <span className={`dot ${busy ? "busy" : q.status}`} />
                {q.text}
              </a>
            );
          })}
        </aside>
        <section className="center">
          {props.threadId ? (
            <ThreadView key={props.threadId} id={props.threadId} onOpenVisual={openVisual} onTrace={setTraceRid} />
          ) : (
            <Landing onStart={go} />
          )}
        </section>
        {wins.map((w) => (
          <VisualWindow
            key={w.key}
            win={w}
            graph={graph}
            onSelect={setTraceRid}
            onFocus={() =>
              setWins((ws) => {
                const z = Math.max(20, ...ws.map((x) => x.z));
                return ws.map((x) => (x.key === w.key && x.z < z ? { ...x, z: z + 1 } : x));
              })
            }
            onClose={() => setWins((ws) => ws.filter((x) => x.key !== w.key))}
            onMove={(x, y) => setWins((ws) => ws.map((o) => (o.key === w.key ? { ...o, x, y } : o)))}
          />
        ))}
        {traceRid && (
          <TraceDrawer rid={traceRid} names={new Map(graph.views.map((v) => [v.id, v.name]))}
                       onClose={() => setTraceRid(null)} onSelect={setTraceRid}
                       onOpenView={() => (window.location.hash = "#/graph")} />
        )}
      </main>
    </div>
  );
}
