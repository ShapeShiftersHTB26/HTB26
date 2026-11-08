import { ReactFlowProvider } from "@xyflow/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { op, Thread } from "../api";
import ChatWindow from "./ChatWindow";
import Notebook from "./Notebook";
import Outline from "./Outline";
import { Ctx, Send } from "./ctx";
import { Rail } from "./Landing";
import ResearchCanvas from "./ResearchCanvas";

/** One research thread: its canvas (the work) plus a floating chat (the conversation), sharing a focus. */
export default function ThreadView(props: {
  id: string;
  onOpenVisual: (visualId: string, viewId: string) => void;
  onTrace: (rid: string) => void;
}) {
  const [t, setT] = useState<Thread | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [noting, setNoting] = useState(false);
  const [noteText, setNoteText] = useState("");
  // #/t/<thread>/nb/<view> opens that table's notebook directly (handy for sharing a receipt)
  const [notebook, setNotebook] = useState<string | null>(() => window.location.hash.match(/\/nb\/([\w-]+)/)?.[1] ?? null);
  const [activeQ, setActiveQ] = useState<string | null>(null);
  const seen = useRef<number | null>(null);

  const load = useCallback(
    () =>
      op<Thread>("get_thread", { intent_id: props.id })
        .then((x) => (setT(x), setErr(null)))
        .catch((e) => setErr(e.message)),
    [props.id],
  );
  useEffect(() => {
    load();
    const h = setInterval(load, 1500);
    return () => clearInterval(h);
  }, [load]);

  // follow the agent: focus the node behind its newest proposal / data card / explicit focus
  useEffect(() => {
    if (!t) return;
    const n = t.items.length;
    if (seen.current === null) return void (seen.current = n);
    if (n <= seen.current) return;
    const fresh = t.items.slice(seen.current);
    seen.current = n;
    for (const it of [...fresh].reverse()) {
      if (it.type === "proposal" && it.proposal.status === "pending") return setFocus(it.proposal.view_id);
      if (it.type === "message" && it.role === "agent") {
        if (it.focus?.length) return setFocus(it.focus[0]);
        if (it.kind === "datasets") return setFocus("datasets");
        if (it.kind === "source" && it.view_id) return setFocus(it.view_id);
      }
      if (it.type === "result") {
        setActiveQ(it.intent_id);
        setFocus(it.view_id);
        if (it.result_kind === "visual" && it.result_current) props.onOpenVisual(it.result_current, it.view_id);
        return;
      }
    }
  }, [t?.items.length]);

  const send: Send = async (text, kind = "chat", f) => {
    await op("ask", { text, intent_id: props.id, kind, focus: f });
    load();
  };
  const addNote = async () => {
    const x = noteText.trim();
    if (!x) return;
    await op("note", { intent_id: props.id, text: x, about: focus && focus !== "datasets" ? focus : null, author: "user" });
    setNoteText("");
    setNoting(false);
    load();
  };

  if (err && !t) return <div className="error pad">{err}</div>;
  if (!t) return <div className="muted pad">loading…</div>;
  return (
    <Ctx.Provider value={{ t, send, reload: load, focus, setFocus, onOpenVisual: props.onOpenVisual, onTrace: props.onTrace,
                          openNotebook: setNotebook, activeQ, setActiveQ }}>
      <div className={`thread-canvas ${notebook ? "with-notebook" : ""}`}>
        <div className="thread-bar">
          <b className="ws-title" title={t.intent.text}>{t.intent.title || t.intent.text}</b>
          {(() => {
            // the bar follows one question: the selected one, else the latest
            const qs = t.canvas.questions;
            const qi = Math.max(0, activeQ ? qs.findIndex((q) => q.id === activeQ) : qs.length - 1);
            const q = qs[qi];
            if (!q) return <Rail stage={t.stage} future={t.stage === "answered"} />;
            return (
              <>
                <span className="rail-q" title={q.text}>Q{qi + 1}: {q.text}</span>
                <Rail stage={q.stage} future={q.stage === "answered"} />
              </>
            );
          })()}
          <span className="grow" />
          <label className="auto-toggle" title="The agent approves its own steps; you're taken to the answer when it's ready">
            <input type="checkbox" checked={!!t.intent.auto}
                   onChange={(e) => op("set_auto", { intent_id: props.id, on: e.target.checked }).then(load)} />
            <span>Auto-accept</span>
          </label>
          {noting ? (
            <form className="note-form" onSubmit={(e) => (e.preventDefault(), addNote())}>
              <input autoFocus value={noteText} onChange={(e) => setNoteText(e.target.value)}
                     placeholder={focus && t.names[focus] ? `note about ${t.names[focus]}…` : "a note for this research…"} />
              <button className="approve" disabled={!noteText.trim()}>Add</button>
              <button type="button" onClick={() => setNoting(false)}>Cancel</button>
            </form>
          ) : (
            <button onClick={() => setNoting(true)}>+ Note</button>
          )}
        </div>
        <div className="ws-body">
          <Outline />
          <ReactFlowProvider>
            <ResearchCanvas />
          </ReactFlowProvider>
        </div>
        {notebook && <Notebook key={notebook} viewId={notebook} onClose={() => setNotebook(null)} />}
        <ChatWindow />
      </div>
    </Ctx.Provider>
  );
}
