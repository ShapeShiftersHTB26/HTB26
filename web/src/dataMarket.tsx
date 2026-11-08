// Shared by Research (making a market from a table) and Predictions (showing what a data-settled market settles on).
import { useEffect, useRef, useState } from "react";

export type Op = ">" | ">=" | "<" | "<=";
export const OP_TEXT: Record<Op, string> = { ">": "above", ">=": "at least", "<": "below", "<=": "at most" };

const SYM: Record<string, string> = { gbp: "£", usd: "$", eur: "€" };

/** 348000 + "GBP" -> "£348,000"; 12.5 + "%" -> "12.5%"; 3 + "count" -> "3". */
export function fmtValue(v: number | null | undefined, unit?: string | null): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const u = (unit || "").toLowerCase();
  const n = (x: number) => x.toLocaleString(undefined, { maximumFractionDigits: Math.abs(x) >= 100 ? 0 : 2 });
  if (SYM[u]) return `${v < 0 ? "-" : ""}${SYM[u]}${n(Math.abs(v))}`;
  if (u === "%" || u === "percent" || u === "pct") return `${n(v)}%`;
  if (!u || u === "count" || u === "number" || u === "rows") return n(v);
  return `${n(v)} ${unit}`;
}

/** Compact: £348k, 1.2M. */
export function fmtShort(v: number, unit?: string | null): string {
  const u = (unit || "").toLowerCase();
  const a = Math.abs(v);
  const body = a >= 1e6 ? `${+(a / 1e6).toFixed(2)}M` : a >= 1e4 ? `${+(a / 1e3).toFixed(1)}k` : a.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const sign = v < 0 ? "-" : "";
  if (SYM[u]) return `${sign}${SYM[u]}${body}`;
  if (u === "%" || u === "percent" || u === "pct") return `${sign}${body}%`;
  return `${sign}${body}`;
}

export const label = (name: string) => name.replace(/_/g, " ");
export const whereText = (where: Record<string, unknown>) =>
  Object.entries(where)
    .map(([k, v]) => `${label(k)} ${v}`)
    .join(", ");

/** "YES if median price for month 2026-10 is above £348,000". */
export function ruleText(r: { column: string; where: Record<string, unknown>; op: Op; threshold: number; unit?: string | null }) {
  const w = whereText(r.where);
  return `${label(r.column)}${w ? ` for ${w}` : ""} is ${OP_TEXT[r.op]} ${fmtValue(r.threshold, r.unit)}`;
}

/**
 * The number's history with the line drawn across it. `target` is the period the market is about: when it isn't in
 * the history yet (a future period) it's drawn as a "?" after the last point.
 */
export function Spark({
  history,
  line,
  unit,
  target,
  yes,
}: {
  history: [string | number, number][];
  line: number;
  unit?: string | null;
  target?: string | number | null;
  /** colours the line's side that settles YES */
  yes?: "above" | "below";
}) {
  // drawn at the container's real width (like PriceChart), so text and dots keep their size at any width
  const wrap = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(480);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(220, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = 104;
  const pad = { l: 6, r: 52, t: 10, b: 18 };
  const future = target !== undefined && target !== null && !history.some(([p]) => String(p) === String(target));
  const n = history.length + (future ? 1 : 0);
  if (!history.length) return <div ref={wrap} className="dspark" />;
  const vals = [...history.map(([, v]) => v), line];
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  const span = hi - lo || Math.abs(hi) || 1;
  lo -= span * 0.12;
  hi += span * 0.12;
  const x = (i: number) => pad.l + (n <= 1 ? 0.5 : i / (n - 1)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const pts = history.map(([, v], i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const ly = y(line);
  const last = history.length - 1;
  const ti = future ? n - 1 : history.findIndex(([p]) => String(p) === String(target));
  return (
    <div ref={wrap} className="dspark">
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="history against the line">
      {yes && (
        <rect
          x={pad.l}
          width={W - pad.l - pad.r}
          y={yes === "above" ? pad.t : ly}
          height={yes === "above" ? Math.max(0, ly - pad.t) : Math.max(0, H - pad.b - ly)}
          fill="var(--dspark-yes, rgba(31,157,85,0.08))"
        />
      )}
      <line x1={pad.l} x2={W - pad.r} y1={ly} y2={ly} stroke="var(--dspark-line, #b7791f)" strokeWidth={1.5} strokeDasharray="5 4" />
      <text x={W - pad.r + 4} y={ly + 4} fontSize={11} fill="var(--dspark-line, #b7791f)">
        {fmtShort(line, unit)}
      </text>
      <polyline points={pts} fill="none" stroke="var(--dspark-ink, #6a4cff)" strokeWidth={2} strokeLinejoin="round" />
      {history.map(([p, v], i) => (
        <circle key={String(p)} cx={x(i)} cy={y(v)} r={i === ti ? 4 : 2.2} fill={i === ti ? "var(--dspark-ink, #6a4cff)" : "var(--dspark-ink, #6a4cff)"} opacity={i === ti || i === last ? 1 : 0.6} />
      ))}
      {future && (
        <>
          <line x1={x(last)} y1={y(history[last][1])} x2={x(ti)} y2={ly} stroke="var(--dspark-ink, #6a4cff)" strokeDasharray="2 3" />
          <circle cx={x(ti)} cy={ly} r={7} fill="var(--dspark-bg, #fff)" stroke="var(--dspark-ink, #6a4cff)" strokeWidth={1.5} />
          <text x={x(ti)} y={ly + 4} fontSize={10} textAnchor="middle" fill="var(--dspark-ink, #6a4cff)" fontWeight={700}>
            ?
          </text>
        </>
      )}
      <text x={x(0)} y={H - 4} fontSize={10} fill="var(--dspark-muted, #6b6b70)">
        {String(history[0][0])}
      </text>
      <text x={x(n - 1)} y={H - 4} fontSize={10} textAnchor="end" fill="var(--dspark-muted, #6b6b70)">
        {String(future ? target : history[last][0])}
      </text>
    </svg>
    </div>
  );
}
