import { useEffect, useRef, useState } from "react";
import { Dataset, op } from "../api";

export type Stage = "ask" | "shape" | "data" | "answer" | "answered";
const STEPS: { key: Stage | "future"; label: string; hint: string }[] = [
  { key: "ask", label: "Ask", hint: "start with a question" },
  { key: "shape", label: "Shape", hint: "agree what the answer looks like" },
  { key: "data", label: "Data", hint: "find and load public data" },
  { key: "answer", label: "Answer", hint: "the result, traced to its sources" },
];
const ORDER: Stage[] = ["ask", "shape", "data", "answer"];

/** The journey strip: dim on the landing, a progress rail in a thread. "Future" joins once there's an answer. */
export function Rail(props: { stage: Stage | null; future?: boolean; hints?: boolean }) {
  // "answered" ticks every step off, Answer included
  const at = props.stage === "answered" ? ORDER.length : props.stage ? ORDER.indexOf(props.stage) : -1;
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


export default function Landing(props: { onStart: (intentId: string) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [auto, setAuto] = useState<boolean>(() => {
    try {
      return localStorage.getItem("backtrace.auto") === "1";
    } catch {
      return false;
    }
  });
  const toggleAuto = (on: boolean) => {
    setAuto(on);
    try {
      localStorage.setItem("backtrace.auto", on ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  };
  const [datasets, setDatasets] = useState<(Dataset & { examples?: string[] })[]>([]);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    op<{ datasets: (Dataset & { examples?: string[] })[] }>("list_datasets")
      .then((r) => setDatasets(r.datasets.filter((d) => d.available)))
      .catch(() => setDatasets([]));
  }, []);
  const pick = (q: string) => {
    setText(q);
    input.current?.focus();
  };
  const start = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await op<{ intent_id: string }>("ask", { text: text.trim(), mode: auto ? "auto" : "guided" });
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
        <input ref={input} autoFocus value={text} onChange={(e) => setText(e.target.value)} disabled={busy}
               placeholder="e.g. Will the flat market in Reading grow next year?" />
        <button className="approve" disabled={busy || !text.trim()}>{busy ? "Starting…" : "Start"}</button>
      </form>
      <label className="auto-toggle landing-auto">
        <input type="checkbox" checked={auto} onChange={(e) => toggleAuto(e.target.checked)} />
        <span>Auto-accept: let the agent approve its own steps and take me straight to the answer</span>
      </label>
      {err && <div className="error small">{err}</div>}
      {datasets.length > 0 && (
        <>
          <div className="label start-label">or start from data we already have</div>
          <div className="start-datasets">
            {datasets.map((d) => (
              <div key={d.id} className="start-ds">
                <div className="ds-title">{d.title}</div>
                <div className="muted small">
                  {d.publisher} · {d.coverage}
                </div>
                <div className="ds-desc small">{d.description}</div>
                <div className="start-qs">
                  {(d.examples || []).map((q) => (
                    <button key={q} className={`example ${text === q ? "picked" : ""}`} onClick={() => pick(q)}>
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      <Rail stage={null} hints />
    </div>
  );
}
