// Prediction-market backend client. The browser goes through the Vite proxy (/pm-api → backend:8080).

export const PM_API = "/pm-api";

export interface PublicConfig {
  rpc_url: string;
  program_id: string;
  openbook_program_id: string;
  musdc_mint: string;
  admin: string;
}

export interface OrderbookRow {
  market_id: number;
  outcome: "yes" | "no";
  ob_market: string;
  bids: string;
  asks: string;
  event_heap: string;
  admin_open_orders: string;
}

export interface MarketInfo {
  id: number;
  question: string;
  description: string | null;
  status: "pending" | "active" | "resolved" | "failed";
  outcome: "yes" | "no" | "void" | null;
  resolution_time: string;
  initial_price_cents: number;
  market_pda: string | null;
  yes_mint: string | null;
  no_mint: string | null;
  vault: string | null;
  error: string | null;
  query_hash: string | null;
  created_at: string;
  resolved_at: string | null;
  yes_book: OrderbookRow | null;
  no_book: OrderbookRow | null;
  /** Set for markets settled by data (Backtrace): the rule, plus `settlement` once resolved. */
  resolution?: DataRule | null;
}

/** "YES if <column> for <where> in <view> is <op> <threshold>", settled by a pinned Backtrace calculation. */
export interface DataRule {
  source: "backtrace";
  view_id: string;
  view_name: string;
  where: Record<string, string | number>;
  column: string;
  unit: string | null;
  op: ">" | ">=" | "<" | "<=";
  threshold: number;
  if_missing: "void";
  formula_hash: string;
  intent_id?: string | null;
  created_from: { instance_id: string; hash: string; value: number | null; files: string[] };
  settlement?: Settlement;
}

export interface DataSourceInfo {
  view_id: string;
  name: string;
  files: string[];
  rows: number;
  hash: string;
}

export interface Settlement {
  value: number | null;
  reason: string;
  instance_id: string;
  hash: string;
  formula_hash: string;
  verified: boolean;
  data: DataSourceInfo[];
  settled_at: string;
  row: Record<string, unknown> | null;
}

/** A data-settled market's number on today's data (Backtrace api, market_status). */
export interface DataStatus {
  market_id: number;
  status: string;
  value?: number | null;
  would_settle?: "yes" | "no" | "void";
  history?: [string | number, number][];
  time_column?: string | null;
  instance?: { id: string; hash: string; created_at: string };
  data?: DataSourceInfo[];
  error?: string;
}

export interface BotTrade {
  id: number;
  book: "yes" | "no";
  side: "buy" | "sell";
  size_lots: number;
  limit_cents: number;
  tx: string;
  created_at: string;
}

export interface CreateMarketInput {
  question: string;
  description?: string;
  resolution_time: string; // ISO
  initial_price_cents?: number;
}

/** Backtrace api ops for data-settled markets (the Vite proxy sends /api to the api service). */
async function op<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`/api/op/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail ?? `HTTP ${res.status}`);
  return body as T;
}

export const dataApi = {
  status: (id: number) => op<DataStatus>("market_status", { market_id: id }),
  settle: (id: number) => op<{ outcome: string; tx?: string }>("settle_market", { market_id: id }),
};

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${PM_API}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

export const pmApi = {
  config: () => req<PublicConfig>("/config"),
  markets: () => req<MarketInfo[]>("/markets"),
  market: (id: number) => req<MarketInfo>(`/markets/${id}`),
  trades: (id: number) => req<BotTrade[]>(`/markets/${id}/trades`),
  faucet: (wallet: string) =>
    req<{ musdc: number; tx: string }>("/faucet", { method: "POST", body: JSON.stringify({ wallet }) }),
  /** Public: anyone can create a market; the backend seeds both books with liquidity. */
  createMarket: (input: CreateMarketInput) =>
    req<{ created: boolean; market: MarketInfo }>("/public/markets", { method: "POST", body: JSON.stringify(input) }),
};
