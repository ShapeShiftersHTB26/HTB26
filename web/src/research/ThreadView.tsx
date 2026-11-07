import { ReactFlowProvider } from "@xyflow/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { op, Thread } from "../api";
import ChatWindow from "./ChatWindow";
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
      if (it.type === "result") return setFocus(it.view_id);
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
    <Ctx.Provider value={{ t, send, reload: load, focus, setFocus, onOpenVisual: props.onOpenVisual, onTrace: props.onTrace }}>
      <div className="thread-canvas">
        <div className="thread-bar">
          <Rail stage={t.stage} future={t.stage === "explore"} />
          <span className="grow" />
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
        <ReactFlowProvider>
          <ResearchCanvas />
        </ReactFlowProvider>
        <ChatWindow />
      </div>
    </Ctx.Provider>
  );
}
