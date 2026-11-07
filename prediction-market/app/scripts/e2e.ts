// End-to-end flow against a running backend + validator, using the same code as the UI.
//   ADMIN_API_KEY=... pnpm e2e        (API_URL defaults to http://localhost:8080)
// Creates a market resolving in ~70s, trades both books as a fresh burner wallet,
// mints/merges sets, resolves YES via the admin API, then redeems.
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import {
  addrsFromConfig,
  bookAddrs,
  ensureAtasIxs,
  loadL2,
  mergeSetIx,
  mintSetIx,
  placeTakeOrderIx,
  redeemIx,
  tokenBalance,
  TOKEN,
} from '../src/solana';
import type { MarketInfo, PublicConfig } from '../src/api';

const API = process.env.API_URL ?? 'http://localhost:8080';
const KEY = process.env.ADMIN_API_KEY ?? '';

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-admin-key': KEY, ...(init?.headers ?? {}) },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${path}: ${body.error ?? res.status}`);
  return body as T;
}

function check(cond: boolean, what: string) {
  if (!cond) throw new Error(`FAILED: ${what}`);
  console.log(`  ✓ ${what}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const cfg = await http<PublicConfig>('/config');
  const a = addrsFromConfig(cfg);
  const conn = new Connection(cfg.rpc_url, 'confirmed');
  const user = Keypair.generate();

  const send = async (ixs: Transaction['instructions']) => {
    const tx = new Transaction().add(...ixs);
    tx.feePayer = user.publicKey;
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.sign(user);
    const sig = await conn.sendRawTransaction(tx.serialize());
    const r = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    if (r.value.err) throw new Error(JSON.stringify(r.value.err));
    return sig;
  };

  console.log('1. create market (resolves in 70s)');
  const resolution = new Date(Date.now() + 70_000).toISOString();
  const m = await http<MarketInfo>('/markets', {
    method: 'POST',
    body: JSON.stringify({ question: `e2e test ${Date.now()}`, resolution_time: resolution, initial_price_cents: 60 }),
  });
  check(m.status === 'active' && !!m.yes_book && !!m.no_book, `market ${m.id} active with YES and NO books`);
  const yesMint = new PublicKey(m.yes_mint!);
  const noMint = new PublicKey(m.no_mint!);
  const bal = async () => ({
    usdc: await tokenBalance(conn, user.publicKey, a.musdc),
    yes: await tokenBalance(conn, user.publicKey, yesMint),
    no: await tokenBalance(conn, user.publicKey, noMint),
  });

  console.log('2. faucet');
  await http('/faucet', { method: 'POST', body: JSON.stringify({ wallet: user.publicKey.toBase58() }) });
  check((await bal()).usdc === 1000, 'burner got 1000 mUSDC');

  console.log('3. books seeded around 60¢ / 40¢');
  const yesL2 = await loadL2(conn, a.openbookId, new PublicKey(m.yes_book!.ob_market));
  const noL2 = await loadL2(conn, a.openbookId, new PublicKey(m.no_book!.ob_market));
  console.log(`  YES ${yesL2.bids[0]?.price}/${yesL2.asks[0]?.price}  NO ${noL2.bids[0]?.price}/${noL2.asks[0]?.price}`);
  check(yesL2.asks[0].price + noL2.asks[0].price > 1, 'YES ask + NO ask > 1 (no arbitrage)');
  check(yesL2.bids[0].price + noL2.bids[0].price < 1, 'YES bid + NO bid < 1 (no arbitrage)');

  const yesBook = bookAddrs(m.yes_book!, m.yes_mint!);
  const noBook = bookAddrs(m.no_book!, m.no_mint!);
  const ask = (l: typeof yesL2) => Math.round(l.asks[0].price * 100);
  const bid = (l: typeof yesL2) => Math.round(l.bids[0].price * 100);

  console.log('4. trade both books');
  await send([...ensureAtasIxs(a, m, user.publicKey), placeTakeOrderIx(a, yesBook, user.publicKey, 'buy', ask(yesL2) + 3, 500)]);
  let b = await bal();
  check(b.yes === 5, 'bought 5 YES on the YES book');
  await send([placeTakeOrderIx(a, noBook, user.publicKey, 'buy', ask(noL2) + 3, 300)]);
  b = await bal();
  check(b.no === 3, 'bought 3 NO on the NO book');
  const usdcBeforeSell = b.usdc;
  const yesNow = await loadL2(conn, a.openbookId, new PublicKey(m.yes_book!.ob_market));
  await send([placeTakeOrderIx(a, yesBook, user.publicKey, 'sell', Math.max(1, bid(yesNow) - 3), 200)]);
  b = await bal();
  check(b.yes === 3 && b.usdc > usdcBeforeSell, 'sold 2 YES for mUSDC');

  console.log('5. mint / merge complete sets');
  await send([mintSetIx(a, m, user.publicKey, BigInt(4 * TOKEN))]);
  b = await bal();
  check(b.yes === 7 && b.no === 7, 'minted 4 sets → 7 YES / 7 NO');
  await send([mergeSetIx(a, m, user.publicKey, BigInt(2 * TOKEN))]);
  b = await bal();
  check(b.yes === 5 && b.no === 5, 'merged 2 sets → 5 YES / 5 NO');

  console.log('6. wait for resolution time, then resolve YES');
  const wait = new Date(resolution).getTime() - Date.now() + 3000;
  if (wait > 0) await sleep(wait);
  await http(`/markets/${m.id}/resolve`, { method: 'POST', body: JSON.stringify({ outcome: 'yes' }) });
  const after = await http<MarketInfo>(`/markets/${m.id}`);
  check(after.status === 'resolved' && after.outcome === 'yes', 'market resolved YES');

  console.log('7. redeem');
  const before = await bal();
  await send([redeemIx(a, after, user.publicKey, BigInt(Math.round(before.yes * TOKEN)), BigInt(Math.round(before.no * TOKEN)))]);
  b = await bal();
  check(Math.abs(b.usdc - (before.usdc + before.yes)) < 1e-6, `redeemed ${before.yes} YES → +${before.yes} mUSDC, NO burned for 0`);
  check(b.yes === 0 && b.no === 0, 'outcome tokens burned');
  console.log('\nE2E PASSED');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
