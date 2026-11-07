import { useEffect, useRef, useState } from "react";
import { chat, Graph } from "./api";

type Item = { kind: "user" | "agent" | "tool" | "error" | "note"; text: string };
type Saved = { session: string | null; items: Item[] };

// Per-browser convenience: the conversation survives a page reload. The graph stays the real state.
const KEY = "backtrace.chat";
function load(): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "null");
    if (v && Array.isArray(v.items)) return v;
  } catch {
    /* storage unavailable or corrupt: start empty */
  }
  return { session: null, items: [] };
}

/** Chat with the app agent (same agent as `claude` in agent/), docked bottom-left of the Main tab. */
export default function ChatPanel(props: { graph: Graph; viewId: string | null; intentId: string | null }) {
  const [saved] = useState(load);
  const [open, setOpen] = useState(true);
  const [items, setItems] = useState<Item[]>(saved.items);
  const [session, setSession] = useState<string | null>(saved.session);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ session, items: items.slice(-200) }));
    } catch {
      /* ignore */
    }
  }, [session, items]);
  useEffect(() => {
    // block body on purpose: newer browsers return a Promise from scrollIntoView, which React treats as a cleanup
    end.current?.scrollIntoView({ block: "end" });
  }, [items, busy, open]);

  const add = (it: Item) => setItems((xs) => [...xs, it]);
  const send = async () => {
    const message = text.trim();
    if (!message || busy) return;
    setText("");
    add({ kind: "user", text: message });
    setBusy(true);
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      await chat({ message, session_id: session, view_id: props.viewId, intent_id: props.intentId }, (e) => {
        if (e.type === "session") setSession(e.session_id);
        else if (e.type === "text") add({ kind: "agent", text: e.text });
        else if (e.type === "tool") add({ kind: "tool", text: e.label });
        else if (e.type === "tool_error") add({ kind: "error", text: e.text });
        else if (e.type === "note") add({ kind: "note", text: e.text });
        else if (e.type === "error") add({ kind: "error", text: e.message });
        else if (e.type === "done" && e.is_error)
          add({ kind: "error", text: (e.errors || []).join("; ") || "the agent stopped with an error" });
      }, ctl.signal);
    } catch (err: any) {
      add(err.name === "AbortError" ? { kind: "note", text: "stopped" } : { kind: "error", text: err.message });
    } finally {
      setBusy(false);
      abort.current = null;
    }
  };
  const newChat = () => {
    setSession(null);
    setItems([]);
  };

  if (!open)
    return (
      <button className="chat-pill" onClick={() => setOpen(true)}>
        Ask Backtrace{busy ? " · working…" : ""}
      </button>
    );

  const view = props.viewId ? props.graph.views.find((v) => v.id === props.viewId) : null;
  const intent = props.intentId ? (props.graph.intents || []).find((q) => q.id === props.intentId) : null;
  return (
    <section className="chat">
      <div className="chat-head">
        <strong>Ask Backtrace</strong>
        <span className="muted small grow">{busy ? "working…" : "the app agent"}</span>
        <button className="small" onClick={newChat} disabled={busy || items.length === 0}>New chat</button>
        <button className="close" title="Minimise" onClick={() => setOpen(false)}>–</button>
      </div>
      <div className="chat-log">
        {items.length === 0 && (
          <div className="muted small">
            Ask a question about the data, e.g. “average flat price in Reading by postcode district, use the Price
            Paid sales”. The agent builds the answer on the canvas. Approve or comment on its proposals there, or
            reply here.
          </div>
        )}
        {items.map((it, i) => (
          <div key={i} className={`chat-msg ${it.kind}`}>
            {it.kind === "tool" ? `→ ${it.text}` : it.text}
          </div>
        ))}
        {busy && <div className="chat-msg note">working…</div>}
        <div ref={end} />
      </div>
      {(view || intent) && (
        <div className="chat-ctx muted small">
          The agent sees what you have open: {view ? <b>{view.name}</b> : <i>“{intent!.text}”</i>}
        </div>
      )}
      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          rows={2}
          value={text}
          disabled={busy}
          placeholder="Ask a question, or answer the agent…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        {busy ? (
          <button type="button" onClick={() => abort.current?.abort()}>Stop</button>
        ) : (
          <button className="send" disabled={!text.trim()}>Send</button>
        )}
      </form>
    </section>
  );
}
