import { useEffect, useRef, useState } from "react";

export type Moment = { at: string; labels: string[] };
export type Replay = { moments: Moment[]; i: number; playing: boolean; speed: number };

const STEP_MS = 1400; // one moment per step at 1×
const END_PAUSE_MS = 2500; // linger on the last moment, then hand the live workspace back

/** One get_replay label split into its verb chip and the rest, plus the table it's about (by name) if any:
 * "Approved shape for flights_2025" -> {verb: "Approved", tone: "approved", text: "shape for flights_2025",
 * view: "flights_2025"}; "Computed flights_2025 (21 rows)" -> view "flights_2025". */
export type Event = { verb: string; tone: string; text: string; view?: string };
const VERBS: [RegExp, string][] = [
  [/^(Proposed) /, "proposed"],
  [/^(Approved) /, "approved"],
  [/^(Discarded) /, "discarded"],
  [/^(Revised) /, "revised"],
  [/^(Computed) /, "computed"],
  [/^(Answered): /, "answered"],
  [/^(Comment): /, "comment"],
  [/^(Note): /, "note"],
  [/^(New question): /, "question"],
  [/^(You): /, "you"],
  [/^(Agent): /, "agent"],
];
export function parseLabel(label: string): Event {
  for (const [re, tone] of VERBS) {
    const m = label.match(re);
    if (!m) continue;
    const text = label.slice(m[0].length);
    const view = tone === "computed" ? text.replace(/ \([\d,]+ rows\)$/, "")
      : ["proposed", "approved", "discarded", "revised"].includes(tone) ? text.match(/ for (\S+)$/)?.[1] : undefined;
    return { verb: m[1], tone, text, view };
  }
  return { verb: "", tone: "other", text: label };
}
// which of a moment's labels to headline: the canvas-changing ones beat chat lines
const RANK = ["answered", "approved", "discarded", "revised", "computed", "proposed", "question", "comment", "note", "agent", "you", "other"];
export function mainEvent(m: Moment): Event {
  return m.labels.map(parseLabel).sort((a, b) => RANK.indexOf(a.tone) - RANK.indexOf(b.tone))[0];
}

const Chip = ({ e }: { e: Event }) => (e.verb ? <span className={`rp-verb rp-${e.tone}`}>{e.verb}</span> : null);

/** Replay of a workspace's history (get_replay moments, each shown with get_thread(at)): read-only. When it
 * reaches the end it hands back the live workspace, which is where the replay ends anyway, so you can carry on. */
export default function ReplayBar(props: { replay: Replay; set: (r: Replay | null) => void }) {
  const { replay: r, set } = props;
  const last = r.moments.length - 1;
  const m = r.moments[r.i];
  const go = (i: number, playing = r.playing) => set({ ...r, i: Math.max(0, Math.min(last, i)), playing });

  useEffect(() => {
    if (!r.playing) return;
    const h = setTimeout(() => (r.i < last ? go(r.i + 1) : set(null)), r.i < last ? STEP_MS / r.speed : END_PAUSE_MS);
    return () => clearTimeout(h);
  }, [r.playing, r.i, r.speed]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input, textarea, select")) return;
      if (e.key === "ArrowRight") go(r.i + 1, false);
      else if (e.key === "ArrowLeft") go(r.i - 1, false);
      else if (e.key === " ") (e.preventDefault(), go(r.i, !r.playing));
      else if (e.key === "Escape") set(null);
      else return;
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  const [log, setLog] = useState(false);
  const cur = useRef<HTMLLIElement>(null);
  useEffect(() => cur.current?.scrollIntoView({ block: "nearest" }), [log, r.i]);

  const t0 = Date.parse(r.moments[0].at);
  const since = (at: string) => {
    const s = Math.round((Date.parse(at) - t0) / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const clock = since(m.at);
  const ev = mainEvent(m);
  const others = m.labels.length - 1;
  return (
    <div className="replay-bar">
      <span className="replay-badge">REPLAY</span>
      <button title="First moment" onClick={() => go(0, false)} disabled={r.i === 0}>⏮</button>
      <button title="Back (←)" onClick={() => go(r.i - 1, false)} disabled={r.i === 0}>◀</button>
      <button className="replay-play" title="Play / pause (space)" onClick={() => go(r.i, !r.playing)}>
        {r.playing ? "⏸" : "▶"}
      </button>
      <button title="Forward (→)" onClick={() => go(r.i + 1, false)} disabled={r.i === last}>▶|</button>
      <select value={r.speed} title="Speed" onChange={(e) => set({ ...r, speed: Number(e.target.value) })}>
        {[0.5, 1, 2, 4].map((s) => <option key={s} value={s}>{s}×</option>)}
      </select>
      <input type="range" min={0} max={last} value={r.i} onChange={(e) => go(Number(e.target.value), false)} />
      <span className="replay-pos small muted">{r.i + 1}/{r.moments.length} · +{clock}</span>
      <span className="replay-label" title={m.labels.join("\n")} onClick={() => setLog(!log)}>
        <Chip e={ev} /> {ev.text}
        {others > 0 && <span className="muted"> (+{others})</span>}
      </span>
      <span className="rp-log-wrap">
        <button title="Every step of this replay; click one to jump there" className={log ? "on" : ""}
                onClick={() => setLog(!log)}>☰ Steps</button>
        {log && (
          <ol className="rp-log">
            {r.moments.map((x, i) => (
              <li key={x.at + i} ref={i === r.i ? cur : undefined} className={i === r.i ? "cur" : i < r.i ? "past" : ""}
                  onClick={() => go(i, false)}>
                <span className="rp-t">+{since(x.at)}</span>
                <span className="rp-evs">
                  {x.labels.map(parseLabel).map((e, k) => (
                    <span key={k} className="rp-ev"><Chip e={e} /> {e.text}</span>
                  ))}
                </span>
              </li>
            ))}
          </ol>
        )}
      </span>
      <button className="approve" title="Back to the workspace as it is now (Esc)" onClick={() => set(null)}>
        Continue from here →
      </button>
    </div>
  );
}
