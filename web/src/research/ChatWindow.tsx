import { useEffect, useRef, useState } from "react";
import { ThreadItem } from "../api";
import { useThread } from "./ctx";

const LABEL = { schema: "shape", transform: "how it's computed", visual: "visual" } as const;

/** The floating chat: conversation only. Proposals appear as links to the node they change on the canvas. */
export default function ChatWindow() {
  const { t, send, focus, setFocus } = useThread();
  const [open, setOpen] = useState(true);
  const [text, setText] = useState("");
  const [busySend, setBusySend] = useState(false);
  const [queuedSince, setQueuedSince] = useState<number | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const status = t.intent.agent_status;
  const busy = status === "queued" || status === "working";
  useEffect(() => setQueuedSince((s) => (status === "queued" ? s ?? Date.now() : null)), [status]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [t.items.length, status, open, t.intent.agent_activity]);

  const focusView = focus && t.names[focus] ? focus : null; // only tables travel with a message
  const focusName = focus === "datasets" ? "the data choice" : focusView ? t.names[focusView] : null;
  const submit = async () => {
    const x = text.trim();
    if (!x) return;
    setBusySend(true);
    try {
      await send(x, "chat", focusView ? [focusView] : undefined);
      setText("");
    } finally {
      setBusySend(false);
    }
  };

  if (!open)
    return (
      <button className="chat-pill research-pill" onClick={() => setOpen(true)}>
        Chat{busy ? " · working…" : ""}
      </button>
    );
  return (
    <section className="chatwin">
      <div className="chat-head">
        <strong>Research chat</strong>
        <span className="muted small grow">{busy ? "working…" : ""}</span>
        <button className="close" title="Minimise" onClick={() => setOpen(false)}>–</button>
      </div>
      <div className="chat-log">
        {t.items.map((it, i) => (
          <Line key={(it as any).id || (it.type === "proposal" ? it.proposal.id : `${it.type}-${i}`)} it={it} />
        ))}
        {busy && (
          <div className="chat-msg note">
            <span className="dots"><i /><i /><i /></span>
            {t.intent.agent_activity ? ` ${t.intent.agent_activity}` : status === "queued" ? " reading your message…" : " working…"}
            {status === "queued" && queuedSince !== null && Date.now() - queuedSince > 15_000 && (
              <div className="small">Nothing picked this up yet: is the api's thread worker on?</div>
            )}
          </div>
        )}
        {status === "error" && (
          <div className="chat-msg error">
            {t.intent.agent_error} <button className="small" onClick={() => send("Please try that again.", "action")}>Retry</button>
          </div>
        )}
        <div ref={end} />
      </div>
      {focusName && (
        <div className="chat-ctx small">
          about <b>{focusName}</b>
          <button className="close small" title="Clear" onClick={() => setFocus(null)}>×</button>
        </div>
      )}
      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          rows={2}
          value={text}
          disabled={busySend}
          placeholder={focusName ? `Ask or change something about ${focusName}…` : "Reply, or ask for a change…"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button className="send" disabled={busySend || !text.trim()}>Send</button>
      </form>
    </section>
  );
}

function Line({ it }: { it: ThreadItem }) {
  const { send, setFocus } = useThread();
  if (it.type === "proposal") {
    const p = it.proposal;
    const what = it.kind === "schema" && p.parent_id ? "a change" : LABEL[it.kind];
    const verb = p.status === "pending" ? "proposed" : p.status === "approved" ? "✓" : "✗ discarded";
    return (
      <a className={`chat-link ${p.status}`} onClick={() => setFocus(p.view_id)}>
        {verb} {what} · <b>{it.view_name}</b> →
      </a>
    );
  }
  if (it.type === "result")
    return (
      <a className="chat-link answer" onClick={() => setFocus(it.view_id)}>
        Answer: {it.summary || it.view_name} →
      </a>
    );
  if (it.kind === "action") return <div className="chat-msg action">{it.text}</div>;
  return (
    <>
      <div className={`chat-msg ${it.role === "user" ? "user" : "agent"}`}>{it.text}</div>
      {it.kind === "datasets" && <a className="chat-link" onClick={() => setFocus("datasets")}>choose the data on the canvas →</a>}
      {it.kind === "source" && it.view_id && <a className="chat-link" onClick={() => setFocus(it.view_id!)}>see the data →</a>}
      {it.kind === "market" && it.market_id != null && <a className="chat-link answer" href={`#/predictions/market/${it.market_id}`}>open market #{it.market_id} →</a>}
      {!!it.suggestions?.length && (
        <div className="suggestions">
          {it.suggestions.map((s) => (
            <button key={s} onClick={() => send(s)}>{s}</button>
          ))}
        </div>
      )}
    </>
  );
}
