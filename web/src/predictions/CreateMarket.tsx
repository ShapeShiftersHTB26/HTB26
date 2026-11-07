import { useState } from "react";
import { pmApi } from "./api";
import { Spinner, useToast } from "./ui";
import { dateLabel } from "./util";

const EXAMPLE = "Will more than 5 houses be sold at RG1 postcode for more than £300,000 until 15 December 2026?";
const MAX = 300;
const PRESETS: [string, number][] = [
  ["1 day", 1],
  ["1 week", 7],
  ["1 month", 30],
];

/** `YYYY-MM-DDTHH:mm` in local time, for <input type="datetime-local">. */
function localInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
const inDays = (d: number) => localInput(new Date(Date.now() + d * 86400_000));

/** Public market creation: the backend creates both order books and seeds them with liquidity. */
export default function CreateMarket({ onCreated }: { onCreated: (id: number) => void }) {
  const toast = useToast();
  const [question, setQuestion] = useState("");
  const [rules, setRules] = useState("");
  const [preset, setPreset] = useState<number | "custom">(7);
  const [custom, setCustom] = useState(() => inDays(7));
  const [prob, setProb] = useState(50);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const q = question.trim();
  const when = new Date(preset === "custom" ? custom : inDays(preset));
  const problem =
    q.length < 10
      ? "Write a question of at least 10 characters"
      : q.length > MAX
        ? `Keep the question under ${MAX} characters`
        : !(when.getTime() > Date.now() + 60_000)
          ? "Pick a close time in the future"
          : null;

  const submit = async () => {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await pmApi.createMarket({
        question: q,
        description: rules.trim() || undefined,
        resolution_time: when.toISOString(),
        initial_price_cents: prob,
      });
      toast(
        r.created
          ? { kind: "ok", title: "Market created", detail: "Both order books are live and seeded with liquidity." }
          : { kind: "info", title: "This market already exists", detail: "Opening it instead." },
      );
      onCreated(r.market.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="pm-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="pm-field">
        <span className="pm-field-label">
          Question
          <span className={`pm-counter${q.length > MAX ? " over" : ""}`}>
            {q.length}/{MAX}
          </span>
        </span>
        <textarea
          rows={3}
          autoFocus
          value={question}
          placeholder={EXAMPLE}
          disabled={busy}
          onChange={(e) => setQuestion(e.target.value)}
        />
        {!question && (
          <button type="button" className="pm-link pm-small" onClick={() => setQuestion(EXAMPLE)}>
            Use this example
          </button>
        )}
      </label>

      <label className="pm-field">
        <span className="pm-field-label">
          Resolution rules <span className="pm-muted">optional</span>
        </span>
        <textarea
          rows={2}
          value={rules}
          disabled={busy}
          placeholder="Resolves Yes if HM Land Registry Price Paid data shows…"
          onChange={(e) => setRules(e.target.value)}
        />
      </label>

      <div className="pm-field">
        <span className="pm-field-label">Trading closes</span>
        <div className="pm-chips">
          {PRESETS.map(([label, d]) => (
            <button type="button" key={d} className={preset === d ? "on" : ""} disabled={busy} onClick={() => setPreset(d)}>
              {label}
            </button>
          ))}
          <button type="button" className={preset === "custom" ? "on" : ""} disabled={busy} onClick={() => setPreset("custom")}>
            Custom
          </button>
        </div>
        {preset === "custom" ? (
          <input type="datetime-local" value={custom} disabled={busy} onChange={(e) => setCustom(e.target.value)} />
        ) : (
          <span className="pm-muted pm-small">{dateLabel(when.toISOString())}</span>
        )}
      </div>

      <div className="pm-field">
        <span className="pm-field-label">
          Starting chance
          <span className="pm-prob-preview">
            <b className="yes">Yes {prob}¢</b> · <b className="no">No {100 - prob}¢</b>
          </span>
        </span>
        <input
          type="range"
          className="pm-range"
          min={5}
          max={95}
          value={prob}
          disabled={busy}
          style={{ ["--fill" as string]: `${((prob - 5) / 90) * 100}%` }}
          onChange={(e) => setProb(Number(e.target.value))}
        />
      </div>

      {error && <div className="pm-banner err">{error}</div>}

      <button type="submit" className="pm-btn pm-btn-primary pm-btn-lg pm-btn-block" disabled={busy || !!problem}>
        {busy ? (
          <>
            <Spinner /> Creating order books…
          </>
        ) : (
          problem ?? "Create market"
        )}
      </button>
      <p className="pm-muted pm-small pm-center">
        {busy
          ? "Seeding Yes and No order books with liquidity. This takes about 10 seconds."
          : "One market per question: asking an existing question opens that market."}
      </p>
    </form>
  );
}
