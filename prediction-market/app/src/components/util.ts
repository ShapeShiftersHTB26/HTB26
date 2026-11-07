export function timeLeft(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'trading closed';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h left`;
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}m ${s % 60}s left`;
}

export const cents = (p: number) => `${Math.round(p * 100)}¢`;
export const fmt = (n: number, d = 2) => n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: 0 });
