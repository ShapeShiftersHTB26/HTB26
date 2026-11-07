import type { ProbPoint } from "./hooks";

/** Implied YES probability sampled client-side every few seconds. */
export default function PriceChart({ points }: { points: ProbPoint[] }) {
  const w = 600;
  const h = 140;
  if (points.length < 2) return <div className="pm-chart-empty muted small">collecting price history…</div>;
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * w;
  const y = (p: number) => h - p * h;
  const d = points.map((pt, i) => `${i ? "L" : "M"}${x(pt.t).toFixed(1)},${y(pt.p).toFixed(1)}`).join(" ");
  return (
    <svg className="pm-chart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="Implied probability over time">
      {[0.25, 0.5, 0.75].map((g) => (
        <line key={g} x1={0} x2={w} y1={y(g)} y2={y(g)} className="pm-grid-line" />
      ))}
      <path d={`${d} L${w},${h} L0,${h} Z`} className="pm-area" />
      <path d={d} className="pm-line" />
    </svg>
  );
}
