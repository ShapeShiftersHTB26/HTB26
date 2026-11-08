import { ReactFlowProvider } from "@xyflow/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { op, Thread } from "../api";
import { FAST_TRACK_AFTER_MS, FOCUS_ANSWER_KEY, startFastTrack } from "../FastTrack";
import ChatWindow from "./ChatWindow";
import Notebook from "./Notebook";
import Outline from "./Outline";
import { Camera, Ctx, Send } from "./ctx";
import { Rail } from "./Landing";
import ReplayBar, { mainEvent, Moment, Replay } from "./ReplayBar";
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
  const [replay, setReplay] = useState<Replay | null>(null);
  const [highlight, setHighlight] = useState<{ id: string; tone: string; key: number } | null>(null);
  const [camera, setCamera] = useState<Camera | null>(null);
  const seen = useRef<number | null>(null);
  const req = useRef(0);
  const replayAt = replay ? replay.moments[replay.i]?.at : null;

  const load = useCallback(() => {
    const n = ++req.current; // only the newest request may land (a live poll must not overwrite a replay frame)
    return op<Thread>("get_thread", { intent_id: props.id, ...(replayAt ? { at: replayAt } : {}) })
      .then((x) => n === req.current && (setT(x), setErr(null)))
      .catch((e) => n === req.current && setErr(e.message));
  }, [props.id, replayAt]);
  useEffect(() => {
    load();
    if (replayAt) return; // a replay frame never changes: no polling
    const h = setInterval(load, 1500);
    return () => clearInterval(h);
  }, [load, replayAt]);

  const showAnswer = (it: { intent_id: string; result_kind?: string; result_current?: string; view_id: string }) => {
    setActiveQ(it.intent_id);
    setFocus(`q:${it.intent_id}`); // the question node carries the full answer: bring it into view
    if (it.result_kind === "visual" && it.result_current) props.onOpenVisual(it.result_current, it.view_id);
  };

  // follow the agent: focus the node behind its newest proposal / data card / explicit focus
  useEffect(() => {
    if (!t) return;
    const n = t.items.length;
    if (replay) return void (seen.current = n); // replay aims the camera itself, one target per step (below)
    if (seen.current === null) {
      seen.current = n;
      let back: string | null = null; // arriving from the fast-track pill: straight to the answer
      try {
        back = sessionStorage.getItem(FOCUS_ANSWER_KEY);
        if (back === props.id) sessionStorage.removeItem(FOCUS_ANSWER_KEY);
      } catch {
        /* no storage: no jump */
      }
      const res = back === props.id ? [...t.items].reverse().find((it) => it.type === "result") : undefined;
      if (res && res.type === "result") showAnswer(res);
      return;
    }
    if (n < seen.current) return void (seen.current = n); // replay stepped back
    if (n === seen.current) return;
    const fresh = t.items.slice(seen.current);
    seen.current = n;
    for (const it of [...fresh].reverse()) {
      if (it.type === "proposal" && it.proposal.status === "pending") return setFocus(it.proposal.view_id);
      if (it.type === "message" && it.role === "agent") {
        if (it.focus?.length) return setFocus(it.focus[0]);
        if (it.kind === "datasets") return setFocus("datasets");
        if (it.kind === "source" && it.view_id) return setFocus(it.view_id);
      }
      if (it.type === "result") return showAnswer(it);
    }
  }, [t?.items.length]);

  // fast track: offered once the agent has been working for a while
  const busy = !replay && !!t && (t.intent.agent_status === "queued" || t.intent.agent_status === "working");
  const [busySince, setBusySince] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => setBusySince((s) => (busy ? s ?? Date.now() : null)), [busy]);
  useEffect(() => {
    if (busySince === null) return;
    const h = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(h);
  }, [busySince]);
  const offerFastTrack = busySince !== null && now - busySince >= FAST_TRACK_AFTER_MS;
  const fastTrack = async () => {
    if (!t) return;
    if (!t.intent.auto) await op("set_auto", { intent_id: props.id, on: true }); // nobody's here to approve steps
    startFastTrack({ id: props.id, title: t.intent.title || t.intent.text,
                     answered: t.canvas.questions.filter((q) => q.status === "answered").length });
    window.location.hash = "#/adhd";
  };

  const startReplay = async () => {
    const r = await op<{ moments: Moment[] }>("get_replay", { intent_id: props.id });
    if (!r.moments.length) return;
    setNotebook(null);
    setNoting(false);
    setFocus(null);
    setActiveQ(null);
    setCamera({ kind: "all", key: Date.now() });
    seen.current = 0;
    setReplay({ moments: r.moments, i: 0, playing: true, speed: 1 });
  };
  // #/t/<thread>/replay starts a replay on open (a demo link)
  const autoReplay = useRef(/\/replay\b/.test(window.location.hash));
  useEffect(() => {
    if (t && autoReplay.current) {
      autoReplay.current = false;
      startReplay();
    }
  }, [!!t]);
  const endReplay = (r: Replay | null) => {
    setReplay(r);
    if (!r) {
      seen.current = null; // back to live: don't re-run the focus jumps for what it already showed
      setHighlight(null);
      setFocus(null);
      setActiveQ(null);
      setCamera({ kind: "all", key: Date.now() }); // land on the whole workspace: questions, tables, sources, notes
    }
  };
  useEffect(() => {
    if (focus) setCamera(null); // a focus (a click, the agent) takes over from any framing request
  }, [focus]);
  // replay: one camera command per step, once that step's frame has landed (no target: the camera stays put)
  //  - a question asked / answered: the question with its tables
  //  - steps proposed / revised / approved, or a derived table computed: the table plus the tables it reads
  //    (the data shelf comes into view with it)
  //  - a source computed or loaded (chat "source" card): that source; a datasets card: the dataset choice
  //  - anything else about a table (its shape, a visual): that table
  useEffect(() => {
    if (!replay || !t || t.intent.at !== replayAt) return;
    const m = replay.moments[replay.i];
    const prevAt = replay.i > 0 ? replay.moments[replay.i - 1].at : "";
    const fresh = t.items.filter((it) => it.at > prevAt && it.at <= m.at);
    const ev = mainEvent(m);
    const onCanvas = (id: string) => t.canvas.nodes.some((n) => n.id === id);
    const viewId = ev.view ? Object.keys(t.names).find((k) => t.names[k] === ev.view && onCanvas(k)) : undefined;
    const frame = (c: Omit<Camera, "key">) => (setFocus(null), setCamera({ ...c, key: Date.now() }));
    const flash = (id: string) => setHighlight({ id, tone: ev.tone, key: replay.i });

    const notes = t.canvas.notes.filter((n) => n.created_at > prevAt && n.created_at <= m.at);
    if (ev.tone === "note" || (notes.length && !viewId && ev.tone !== "answered")) {
      // agent notes: the note(s) with what they're about (a table, else the question they hang off)
      const firstQ = t.canvas.questions[0]?.id;
      const about = notes.map((n) => (n.about && onCanvas(n.about) ? n.about : firstQ ? `q:${firstQ}` : null));
      const ids = [...notes.map((n) => `note:${n.id}`), ...about.filter((x): x is string => !!x)];
      if (!ids.length) return;
      frame({ kind: "nodes", ids: [...new Set(ids)] });
      setHighlight({ id: `note:${notes[notes.length - 1].id}`, tone: "note", key: replay.i });
    } else if (ev.tone === "answered" || ev.tone === "question") {
      const q = t.canvas.questions.find((x) => x.text.slice(0, 80) === ev.text.slice(0, 80));
      if (!q) return;
      setActiveQ(q.id);
      frame({ kind: "chain", q: q.id });
    } else if (viewId && ev.text.startsWith("steps") || (viewId && ev.tone === "computed"
               && t.canvas.nodes.find((n) => n.id === viewId)?.kind !== "source")) {
      const inputs = t.canvas.edges.filter((e) => e.from === viewId).map((e) => e.to).filter(onCanvas);
      frame({ kind: "nodes", ids: [viewId!, ...inputs] });
      flash(viewId!);
    } else if (viewId && ev.tone === "computed") {
      setFocus(viewId);
      flash(viewId);
    } else {
      const card = [...fresh].reverse().find((it) => it.type === "message" && (it.kind === "source" || it.kind === "datasets"));
      if (card && card.type === "message" && card.kind === "source" && card.view_id && onCanvas(card.view_id)) {
        setFocus(card.view_id);
        flash(card.view_id);
      } else if (card && card.type === "message" && card.kind === "datasets" && t.canvas.open_datasets.length) {
        setFocus("datasets");
      } else if (viewId) {
        setFocus(viewId);
        flash(viewId);
      } else return;
    }
    const h = setTimeout(() => setHighlight(null), 1200);
    return () => clearTimeout(h);
  }, [t?.intent.at, replayAt]);

  const send: Send = async (text, kind = "chat", f) => {
    if (replay) return; // read-only while replaying
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
                          openNotebook: setNotebook, activeQ, setActiveQ, readOnly: !!replay, highlight, camera }}>
      <div className={`thread-canvas ${notebook ? "with-notebook" : ""} ${replay ? "replaying" : ""}`}>
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
          {offerFastTrack && (
            <button className="bar-btn fast-track" onClick={fastTrack}
                    title="Taking a while? Go play on the ADHD tab: auto-accept goes on and you get a ping when the answer is ready">
              ⚡ Fast track
            </button>
          )}
          {!replay && !busy && t.items.length > 1 && (
            <button className="bar-btn bar-icon" onClick={startReplay} aria-label="Replay"
                    title="Replay how this workspace got here, step by step (read-only); it ends back here">
              ⟲
            </button>
          )}
          <label className="auto-toggle" title="The agent approves its own steps; you're taken to the answer when it's ready">
            <input type="checkbox" checked={!!t.intent.auto} disabled={!!replay}
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
            <button className="bar-btn" onClick={() => setNoting(true)} disabled={!!replay}>+ Note</button>
          )}
        </div>
        {replay && <ReplayBar replay={replay} set={endReplay} />}
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
