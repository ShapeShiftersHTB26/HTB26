import type { MarketInfo } from "./api";
import type { Level } from "./solana";

export type Outcome = "yes" | "no";
export const outcomeLabel = (o: Outcome) => (o === "yes" ? "Yes" : "No");

export const marketHref = (id: number, buy?: Outcome) => `#/predictions/market/${id}${buy ? `?buy=${buy}` : ""}`;

/** Which way the market leans, for colouring plain-language labels. */
export const lean = (p: number): "yes" | "no" | "even" => (p >= 0.55 ? "yes" : p <= 0.45 ? "no" : "even");

/** A probability in words. */
export function likelihood(p: number): string {
  if (p >= 0.9) return "Almost certain";
  if (p >= 0.7) return "Likely";
  if (p >= 0.55) return "Leaning yes";
  if (p > 0.45) return "Toss-up";
  if (p > 0.3) return "Leaning no";
  if (p > 0.1) return "Unlikely";
  return "Very unlikely";
}

const FRACTIONS: [number, number][] = [[1, 10], [1, 5], [1, 4], [1, 3], [2, 5], [1, 2], [3, 5], [2, 3], [3, 4], [4, 5], [9, 10]];
/** "about 3 in 5": the closest everyday fraction. */
export function roughly(p: number): string {
  if (p < 0.05) return "less than 1 in 20";
  if (p > 0.95) return "more than 19 in 20";
  const [a, b] = FRACTIONS.reduce((best, f) => (Math.abs(f[0] / f[1] - p) < Math.abs(best[0] / best[1] - p) ? f : best));
  return `about ${a} in ${b}`;
}

/** Where a market is in its life, as the UI shows it. "active" markets past their close time await resolution. */
export type Phase = "pending" | "open" | "awaiting" | "resolved" | "failed";
export function phase(m: MarketInfo): Phase {
  if (m.status === "active") return new Date(m.resolution_time).getTime() > Date.now() ? "open" : "awaiting";
  return m.status;
}

/** "6d 4h", "3h 12m", "4m 10s" until `iso`; null once it has passed. */
export function countdown(iso: string): string | null {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return null;
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

export const dateLabel = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });

export function ago(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const cents = (p: number) => `${Math.round(p * 100)}¢`;
export const pct = (p: number, d = 0) => `${(p * 100).toFixed(d)}%`;
export const fmt = (n: number, d = 2) => n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: 0 });
/** mUSDC is the demo dollar: show it like money. */
export const usd = (n: number) =>
  `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const short = (s: string, n = 4) => `${s.slice(0, n)}…${s.slice(-n)}`;

/** How many shares `budget` buys walking the asks, never paying more than `limit`. */
export function sharesForBudget(levels: Level[], budget: number, limit: number): number {
  let left = budget;
  let shares = 0;
  for (const l of levels) {
    if (left <= 0 || l.price > limit) break;
    const take = Math.min(l.size, left / l.price);
    shares += take;
    left -= take * l.price;
  }
  return shares;
}

/** Solana Explorer link for the cluster behind `rpc` (devnet, mainnet, or a custom/local RPC). */
export function explorer(kind: "tx" | "address", id: string, rpc: string): string {
  const cluster = rpc.includes("devnet")
    ? "?cluster=devnet"
    : rpc.includes("mainnet")
      ? ""
      : `?cluster=custom&customUrl=${encodeURIComponent(rpc)}`;
  return `https://explorer.solana.com/${kind}/${id}${cluster}`;
}
