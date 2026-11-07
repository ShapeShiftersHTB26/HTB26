import { useState } from "react";
import { pmApi } from "./api";

const EXAMPLE = "Will more than 5 houses be sold at RG1 postcode for more than £300,000 until 15 December 2026?";

/** `YYYY-MM-DDTHH:mm` in local time, for <input type="datetime-local">. */
function localInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Public market creation: the backend creates both order books and seeds them with liquidity. */
export default function CreateMarket({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const [question, setQuestion] = useState("");
  const [description, setDescription] = useState("");
  const [resolution, setResolution] = useState(() => localInput(new Date(Date.now() + 7 * 86400_000)));
  const [prob, setProb] = useState(50);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const q = question.trim();
  const when = new Date(resolution);
  const problem =
    q.length < 10 ? "Question must be at least 10 characters" :
    q.length > 300 ? "Question must be at most 300 characters" :
    !(when.getTime() > Date.now() + 60_000) ? "Resolution time must be in the future" : null;

  const submit = async () => {
    if (problem) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await pmApi.createMarket({
        question: q,
        description: description.trim() || undefined,
        resolution_time: when.toISOString(),
        initial_price_cents: prob,
      });
      setMsg({ ok: true, text: r.created ? "Market created and seeded." : "A market for this query already exists — opening it." });
      onCreated(r.market.id);
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pm-card pm-create">
      <div className="pm-row pm-between">
        <h3>Create a market</h3>
        <button className="pm-btn pm-ghost" onClick={onClose} disabled={busy}>Cancel</button>
      </div>
      <label className="pm-stack">
        <span className="muted small">Question (one market per query — the same question opens the existing market)</span>
        <textarea rows={2} value={question} placeholder={EXAMPLE} onChange={(e) => setQuestion(e.target.value)} />
        <button className="pm-link small" type="button" onClick={() => setQuestion(EXAMPLE)}>use example</button>
      </label>
      <label className="pm-stack">
        <span className="muted small">Resolution rules (optional)</span>
        <input value={description} placeholder="Resolves YES if HM Land Registry Price Paid data shows …" onChange={(e) => setDescription(e.target.value)} />
      </label>
      <div className="pm-create-row">
        <label className="pm-stack">
          <span className="muted small">Trading closes / resolves at</span>
          <input type="datetime-local" value={resolution} onChange={(e) => setResolution(e.target.value)} />
        </label>
        <label className="pm-stack">
          <span className="muted small">Starting YES probability: <b>{prob}%</b></span>
          <input type="range" min={5} max={95} value={prob} onChange={(e) => setProb(Number(e.target.value))} />
        </label>
      </div>
      <button className="pm-btn pm-primary" disabled={busy || !!problem} onClick={submit}>
        {busy ? "Creating market & seeding liquidity…" : problem ?? "Create market"}
      </button>
      {msg && <div className={msg.ok ? "pm-ok small" : "error small"}>{msg.text}</div>}
      <div className="muted small">
        Creates YES/mUSDC and NO/mUSDC order books on OpenBook and seeds both with a liquidity ladder around the starting
        probability. Takes ~10 seconds.
      </div>
    </div>
  );
}
