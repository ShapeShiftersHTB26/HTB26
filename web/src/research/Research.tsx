import { ReactNode, useEffect, useState } from "react";
import { Graph, op } from "../api";
import TraceDrawer from "../TraceDrawer";
import VisualWindow, { Win } from "../VisualWindow";
import Landing from "./Landing";
import ThreadView from "./ThreadView";

const SIDEBAR_KEY = "backtrace.sidebar.collapsed";

/** The Research tab: question-first chat threads. The canvas lives on the Graph tab. */
export default function Research(props: { nav: ReactNode; hidden: boolean; threadId: string | null }) {
  const [graph, setGraph] = useState<Graph>({ views: [], edges: [], intents: [] });
  const [wins, setWins] = useState<Win[]>([]);
  const [traceRid, setTraceRid] = useState<string | null>(null);
  // the "Your research" list folds to a narrow strip; remembered per browser
  const [collapsed, setCollapsedState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === "1";
    } catch {
      return false;
    }
  });
  const setCollapsed = (c: boolean) => {
    setCollapsedState(c);
    try {
      localStorage.setItem(SIDEBAR_KEY, c ? "1" : "0");
    } catch {
      /* private mode: just not remembered */
    }
  };

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
  const [deleting, setDeleting] = useState<string | null>(null);
  const remove = async (id: string) => {
    type Plan = { title: string; questions: number; messages: number; notes: number; deleted_tables: string[];
                  kept_tables: { name: string; why: string }[] };
    setDeleting(id);
    try {
      const p = await op<Plan>("delete_workspace", { intent_id: id, dry_run: true });
      const n = p.deleted_tables.length;
      const lines = [
        `Delete "${p.title}"?`,
        "",
        `${p.questions} question${p.questions === 1 ? "" : "s"}, ${p.messages} chat messages, ${p.notes} notes` +
          (n ? `, and ${n} table${n === 1 ? "" : "s"} with their rows:` : "."),
        ...p.deleted_tables.map((x) => `  • ${x}`),
        ...(p.kept_tables.length ? ["", "Kept:", ...p.kept_tables.map((k) => `  • ${k.name} (${k.why})`)] : []),
        "",
        "Loaded source data stays. This can't be undone.",
      ];
      if (!window.confirm(lines.join("\n"))) return;
      await op("delete_workspace", { intent_id: id });
      setGraph((g) => ({ ...g, intents: (g.intents || []).filter((q) => q.id !== id && q.parent_id !== id) }));
      setWins([]);
      if (props.threadId === id) go(null);
    } catch (e) {
      window.alert(`Couldn't delete: ${(e as Error).message}`);
    } finally {
      setDeleting(null);
    }
  };
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
        <aside className={`threads ${collapsed ? "collapsed" : ""}`}>
          <div className="threads-top">
            <button className={`new ${props.threadId ? "" : "active"}`} onClick={() => go(null)}
                    title="Start a new research workspace">
              {collapsed ? "+" : "+ New research"}
            </button>
            <button className="threads-toggle" onClick={() => setCollapsed(!collapsed)}
                    title={collapsed ? "Show your research" : "Hide the research list"}
                    aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
              {collapsed ? "»" : "«"}
            </button>
          </div>
          {!collapsed && <div className="label">Your research</div>}
          {threads.map((q) => {
            const busy = q.agent_status === "queued" || q.agent_status === "working";
            return (
              <a key={q.id} className={q.id === props.threadId ? "active" : ""} onClick={() => go(q.id)}
                 title={collapsed ? q.title || q.text : q.text}>
                <span className={`dot ${busy ? "busy" : q.status}`} />
                {!collapsed && <span className="thread-name">{q.title || q.text}</span>}
                {!collapsed && !busy && (
                  <button className="thread-del" title="Delete this workspace" aria-label="Delete workspace"
                          disabled={deleting === q.id} onClick={(e) => (e.stopPropagation(), remove(q.id))}>
                    {deleting === q.id ? "…" : "🗑"}
                  </button>
                )}
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
