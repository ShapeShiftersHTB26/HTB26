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
