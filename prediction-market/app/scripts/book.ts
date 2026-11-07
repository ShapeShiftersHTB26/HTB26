// Print both order books of a market:  pnpm book <market id>
import { Connection, PublicKey } from '@solana/web3.js';
import { loadL2 } from '../src/solana';

const API = process.env.API_URL ?? 'http://localhost:8080';

async function main() {
  const id = process.argv[2] ?? '1';
  const cfg = await (await fetch(`${API}/config`)).json();
  const m = await (await fetch(`${API}/markets/${id}`)).json();
  const conn = new Connection(cfg.rpc_url, 'confirmed');
  console.log(`#${m.id} ${m.question} [${m.status}]`);
  for (const k of ['yes_book', 'no_book'] as const) {
    if (!m[k]) continue;
    const l = await loadL2(conn, new PublicKey(cfg.openbook_program_id), new PublicKey(m[k].ob_market), 5);
    const fmt = (xs: { price: number; size: number }[]) => xs.map((x) => `${Math.round(x.price * 100)}¢×${x.size}`).join(' ');
    console.log(`${k === 'yes_book' ? 'YES' : 'NO '}  bids ${fmt(l.bids)}  |  asks ${fmt(l.asks)}`);
  }
  const s = await (await fetch(`${API}/bots/status`)).json();
  console.log('fair YES price (bots):', s.fair_prices[id]?.toFixed(2), '¢   bot trades last minute:', s.trades_last_minute);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
