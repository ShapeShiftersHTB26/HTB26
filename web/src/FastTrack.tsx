import { useEffect, useRef, useState } from "react";
import { op, Thread } from "./api";

/** "Fast track": while the agent works on a question, go play on the ADHD tab; a pill follows you around and
 * tells you (browser notification too) when the answer is ready, with a link straight back to it.
 * The watched workspace is kept per browser tab (sessionStorage), so it survives switching tabs and reloads. */

export const FAST_TRACK_AFTER_MS = 5000; // the button appears once the agent has been at it this long
const KEY = "bt:fasttrack";
export const FOCUS_ANSWER_KEY = "bt:focus-answer"; // ThreadView: focus the newest answer on open

type FT = { id: string; title: string; answered: number; since: number };
type St = { phase: "working" | "ready" | "stopped"; activity?: string; summary?: string; error?: string };

const store = {
  get(): FT | null {
    try {
      return JSON.parse(sessionStorage.getItem(KEY) || "null");
    } catch {
      return null;
    }
  },
  set(ft: FT | null) {
    try {
      ft ? sessionStorage.setItem(KEY, JSON.stringify(ft)) : sessionStorage.removeItem(KEY);
    } catch {
      /* private mode: the pill just won't survive a reload */
    }
    window.dispatchEvent(new Event(KEY));
  },
};

export function startFastTrack(ft: Omit<FT, "since">) {
  store.set({ ...ft, since: Date.now() });
  try {
    if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission();
  } catch {
    /* no notifications here: the pill is enough */
  }
}

export function openAnswer(id: string) {
  try {
    sessionStorage.setItem(FOCUS_ANSWER_KEY, id);
  } catch {
    /* fine: the thread opens without the focus jump */
  }
  window.location.hash = `#/t/${id}`;
}

const answeredCount = (t: Thread) => t.canvas.questions.filter((q) => q.status === "answered").length;

export default function FastTrack(props: { hash: string }) {
  const [ft, setFt] = useState<FT | null>(store.get);
  const [st, setSt] = useState<St>({ phase: "working" });
  const [now, setNow] = useState(Date.now());
  const told = useRef(false);

  useEffect(() => {
    const on = () => (setFt(store.get()), setSt({ phase: "working" }), (told.current = false));
    window.addEventListener(KEY, on);
    return () => window.removeEventListener(KEY, on);
  }, []);

  useEffect(() => {
    if (!ft || st.phase !== "working") return;
    let alive = true;
    const poll = async () => {
      try {
        const t = await op<Thread>("get_thread", { intent_id: ft.id });
        if (!alive) return;
        const s = t.intent.agent_status;
        if (s === "queued" || s === "working") return setSt({ phase: "working", activity: t.intent.agent_activity });
        const qs = t.canvas.questions.filter((q) => q.status === "answered");
        if (answeredCount(t) > ft.answered) setSt({ phase: "ready", summary: qs[qs.length - 1]?.summary });
        else setSt({ phase: "stopped", error: s === "error" ? t.intent.agent_error : undefined });
      } catch {
        /* the api is restarting: try again on the next tick */
      }
    };
    poll();
    const h = setInterval(poll, 2000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive = false;
      clearInterval(h);
      clearInterval(tick);
    };
  }, [ft?.id, ft?.since, st.phase]);

  // tell them once: browser notification, a nudge for the ADHD page, and the tab title
  useEffect(() => {
    if (!ft || st.phase === "working" || told.current) return;
    told.current = true;
    const title = st.phase === "ready" ? "✅ Your answer is ready" : "✋ The agent needs you";
    try {
      if ("Notification" in window && Notification.permission === "granted" && document.hidden !== false) {
        const n = new Notification(title, { body: st.summary || ft.title, tag: KEY });
        n.onclick = () => (window.focus(), openAnswer(ft.id), store.set(null));
      }
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new CustomEvent("bt:answer-ready", { detail: { ready: st.phase === "ready" } }));
    const old = document.title;
    let on = false;
    const h = setInterval(() => (document.title = (on = !on) ? title : old), 900);
    const stop = () => (clearInterval(h), (document.title = old));
    setTimeout(stop, 12_000);
    window.addEventListener("focus", stop, { once: true });
  }, [st.phase]);

  if (!ft) return null;
  const here = props.hash.startsWith(`#/t/${ft.id}`);
  if (here && st.phase !== "working") {
    queueMicrotask(() => store.set(null)); // they're looking at it: done
    return null;
  }
  if (here) return null; // watching it themselves: no pill

  const secs = Math.max(0, Math.round((now - ft.since) / 1000));
  const back = () => (openAnswer(ft.id), store.set(null));
  return (
    <div className={`fasttrack ${st.phase}`} role="status">
      {st.phase === "working" ? (
        <>
          <span className="ft-spin">⚡</span>
          <span className="ft-text">
            <b>Fast track</b> · {ft.title}
            <span className="small"> · {st.activity || "the agent is on it"} · {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}</span>
          </span>
          <button onClick={back} title="Watch it work instead">peek</button>
        </>
      ) : st.phase === "ready" ? (
        <>
          <span className="ft-spin">✅</span>
          <span className="ft-text">
            <b>Your answer is ready!</b>
            {st.summary && <span className="small"> {st.summary.length > 120 ? st.summary.slice(0, 117) + "…" : st.summary}</span>}
          </span>
          <button className="approve" onClick={back}>Take me there</button>
        </>
      ) : (
        <>
          <span className="ft-spin">✋</span>
          <span className="ft-text">
            <b>The agent stopped</b> and needs you{st.error ? `: ${st.error.slice(0, 100)}` : "."}
          </span>
          <button className="approve" onClick={back}>Back to it</button>
        </>
      )}
      <button className="close" title="Stop watching" onClick={() => store.set(null)}>×</button>
    </div>
  );
}
