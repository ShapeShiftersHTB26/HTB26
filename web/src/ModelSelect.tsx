/** Chat model picker: the api accepts exactly these (api/app/chat.py MODELS). Prices per million tokens in/out. */
export const MODELS = [
  { key: "haiku", id: "claude-haiku-5-5", label: "Haiku 5.5", hint: "fastest, cheapest ($0.10 / $0.50 per M tokens)" },
  { key: "sonnet", id: "claude-sonnet-5-5", label: "Sonnet 5.5", hint: "~20× Haiku ($2 / $10 per M tokens)" },
  { key: "opus", id: "claude-opus-5-5", label: "Opus 5.5", hint: "~40× Haiku ($4 / $20 per M tokens)" },
] as const;
export type ModelKey = (typeof MODELS)[number]["key"];

export const modelKey = (idOrKey?: string | null): ModelKey =>
  (MODELS.find((m) => m.id === idOrKey || m.key === idOrKey)?.key ?? "haiku") as ModelKey;

export default function ModelSelect(props: { value: ModelKey; onChange: (m: ModelKey) => void; disabled?: boolean }) {
  const cur = MODELS.find((m) => m.key === props.value)!;
  return (
    <select className="model-select" value={props.value} disabled={props.disabled} title={`Chat model: ${cur.hint}`}
            onChange={(e) => props.onChange(e.target.value as ModelKey)}>
      {MODELS.map((m) => (
        <option key={m.key} value={m.key} title={m.hint}>
          {m.label}
        </option>
      ))}
    </select>
  );
}
