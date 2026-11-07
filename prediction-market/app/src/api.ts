// Backend REST client (see backend/src/routes.rs).

export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:8080';

export interface PublicConfig {
  rpc_url: string;
  program_id: string;
  openbook_program_id: string;
  musdc_mint: string;
  admin: string;
}

export interface OrderbookRow {
  market_id: number;
  outcome: 'yes' | 'no';
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
  status: 'pending' | 'active' | 'resolved' | 'failed';
  outcome: 'yes' | 'no' | 'void' | null;
  resolution_time: string;
  initial_price_cents: number;
  market_pda: string | null;
  yes_mint: string | null;
  no_mint: string | null;
  vault: string | null;
  error: string | null;
  created_at: string;
  resolved_at: string | null;
  yes_book: OrderbookRow | null;
  no_book: OrderbookRow | null;
}

export interface BotTrade {
  id: number;
  book: 'yes' | 'no';
  side: 'buy' | 'sell';
  size_lots: number;
  limit_cents: number;
  tx: string;
  created_at: string;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

export const api = {
  config: () => req<PublicConfig>('/config'),
  markets: () => req<MarketInfo[]>('/markets'),
  market: (id: number) => req<MarketInfo>(`/markets/${id}`),
  trades: (id: number) => req<BotTrade[]>(`/markets/${id}/trades`),
  faucet: (wallet: string) =>
    req<{ musdc: number; tx: string }>('/faucet', { method: 'POST', body: JSON.stringify({ wallet }) }),
};
