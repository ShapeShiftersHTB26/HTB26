import { useEffect, useId, useRef, useState } from "react";
import type { ProbPoint } from "./hooks";
import { Skeleton } from "./ui";

const H = 240;
const PAD = { top: 12, right: 44, bottom: 22, left: 4 };
const STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.25];

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const time = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Implied YES probability, sampled live while the page is open (cached across navigation in the tab). */
export default function PriceChart({
  points,
  current,
  reference,
}: {
  points: ProbPoint[];
  current: number | null;
  /** Optional dashed line, e.g. the market's launch price. */
  reference?: { p: number; label: string };
}) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const gid = useId().replace(/:/g, "");

  // A single sample still deserves a line: extend it back a little.
  const pts = points.length >= 2 ? points : current !== null ? [{ t: Date.now() - 30_000, p: current }, { t: Date.now(), p: current }] : [];
  if (!pts.length || !width) {
    return (
      <div ref={ref} className="pm-chart">
        <Skeleton h={H} />
      </div>
    );
  }

  // Auto-scale around the data (with a minimum 10-point window) so small moves are visible.
  const ps = pts.map((p) => p.p).concat(reference ? [reference.p] : []);
  let lo = Math.min(...ps);
  let hi = Math.max(...ps);
  const mid = (lo + hi) / 2;
  const span = Math.max(0.1, (hi - lo) * 1.4);
  lo = Math.max(0, mid - span / 2);
  hi = Math.min(1, lo + span);
  lo = Math.max(0, hi - span);
  const step = STEPS.find((s) => (hi - lo) / s <= 5) ?? 0.25;
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(+v.toFixed(4));

  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t;
  const iw = width - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const x = (t: number) => PAD.left + ((t - t0) / Math.max(1, t1 - t0)) * iw;
  const y = (p: number) => PAD.top + (1 - (p - lo) / Math.max(1e-6, hi - lo)) * ih;
  const line = pts.map((pt, i) => `${i ? "L" : "M"}${x(pt.t).toFixed(1)},${y(pt.p).toFixed(1)}`).join("");
  const area = `${line}L${x(t1).toFixed(1)},${PAD.top + ih}L${x(t0).toFixed(1)},${PAD.top + ih}Z`;
  const last = pts[pts.length - 1];
  const hp = hover !== null ? pts[hover] : null;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const t = t0 + ((e.clientX - r.left - PAD.left) / iw) * (t1 - t0);
    let best = 0;
    pts.forEach((p, i) => Math.abs(p.t - t) < Math.abs(pts[best].t - t) && (best = i));
    setHover(best);
  };

  return (
    <div ref={ref} className="pm-chart">
      <svg width={width} height={H} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label="Chance of Yes over time">
        <defs>
          <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--pm-line)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--pm-line)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={PAD.left + iw} y1={y(v)} y2={y(v)} className="pm-chart-grid" />
            <text x={width - 4} y={y(v) + 4} textAnchor="end" className="pm-chart-tick">
              {Math.round(v * 100)}%
            </text>
          </g>
        ))}
        <text x={PAD.left} y={H - 4} className="pm-chart-tick">{time(t0)}</text>
        <text x={PAD.left + iw} y={H - 4} textAnchor="end" className="pm-chart-tick">{time(t1)}</text>
        {reference && (
          <g>
            <line x1={PAD.left} x2={PAD.left + iw} y1={y(reference.p)} y2={y(reference.p)} className="pm-chart-ref" />
            <text x={PAD.left + 6} y={y(reference.p) - 6} className="pm-chart-ref-label">
              {reference.label}
            </text>
          </g>
        )}
        <path d={area} fill={`url(#${gid})`} />
        <path d={line} className="pm-chart-line" />
        {!hp && (
          <>
            <circle cx={x(last.t)} cy={y(last.p)} r={9} className="pm-chart-pulse" />
            <circle cx={x(last.t)} cy={y(last.p)} r={4} className="pm-chart-dot" />
          </>
        )}
        {hp && (
          <g>
            <line x1={x(hp.t)} x2={x(hp.t)} y1={PAD.top} y2={PAD.top + ih} className="pm-chart-cross" />
            <circle cx={x(hp.t)} cy={y(hp.p)} r={4.5} className="pm-chart-dot" />
          </g>
        )}
      </svg>
      {hp && (
        <div className="pm-chart-tip" style={{ left: Math.min(Math.max(x(hp.t), 60), width - 60) }}>
          <b>{(hp.p * 100).toFixed(1)}%</b> <span>{time(hp.t)}</span>
        </div>
      )}
    </div>
  );
}
