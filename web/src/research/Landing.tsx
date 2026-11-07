import { useState } from "react";
import { op } from "../api";

export type Stage = "ask" | "shape" | "data" | "explore";
const STEPS: { key: Stage | "future"; label: string; hint: string }[] = [
  { key: "ask", label: "Ask", hint: "start with a question" },
  { key: "shape", label: "Shape", hint: "agree what the answer looks like" },
  { key: "data", label: "Data", hint: "find and load public data" },
  { key: "explore", label: "Explore", hint: "see it, trace it, go deeper" },
];
const ORDER: Stage[] = ["ask", "shape", "data", "explore"];

/** The journey strip: dim on the landing, a progress rail in a thread. "Future" joins once there's an answer. */
export function Rail(props: { stage: Stage | null; future?: boolean; hints?: boolean }) {
  const at = props.stage ? ORDER.indexOf(props.stage) : -1;
  const steps = props.future ? [...STEPS, { key: "future" as const, label: "Future", hint: "what happens next?" }] : STEPS;
  return (
    <ol className={`rail ${props.hints ? "with-hints" : ""}`}>
      {steps.map((s, i) => {
        const state = s.key === "future" ? "next" : i < at ? "done" : i === at ? "current" : "todo";
        return (
          <li key={s.key} className={state}>
            <span className="rail-dot">{state === "done" ? "✓" : i + 1}</span>
            <span className="rail-label">{s.label}</span>
            {props.hints && <span className="rail-hint">{s.hint}</span>}
          </li>
        );
      })}
    </ol>
  );
}

const EXAMPLES = [
  "How have Reading flat prices changed?",
  "Will the flat market in Reading grow next year?",
  "Are new builds in Reading selling at a premium?",
];

export default function Landing(props: { onStart: (intentId: string) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const start = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await op<{ intent_id: string }>("ask", { text: text.trim() });
      props.onStart(r.intent_id);
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  };
  return (
    <div className="landing">
      <h1>What would you like to research today?</h1>
      <p className="lead">
        Start with a question. We'll work out what data you need, find it, help you load it and explore it with you. Every
        number traces back to its source.
      </p>
      <form
        className="hero-input"
        onSubmit={(e) => {
          e.preventDefault();
          start();
        }}
      >
        <input autoFocus value={text} onChange={(e) => setText(e.target.value)} disabled={busy}
               placeholder="e.g. Will the flat market in Reading grow next year?" />
        <button className="approve" disabled={busy || !text.trim()}>{busy ? "Starting…" : "Start"}</button>
      </form>
      {err && <div className="error small">{err}</div>}
      <div className="examples">
        {EXAMPLES.map((x) => (
          <button key={x} className="example" onClick={() => setText(x)}>
            {x}
          </button>
        ))}
      </div>
      <Rail stage={null} hints />
    </div>
  );
}
