// Prediction markets — on-chain helpers: our program's set instructions, OpenBook take orders, book + balance reads.
import { AnchorProvider } from '@coral-xyz/anchor';
import { Market, OpenBookV2Client } from '@openbook-dex/openbook-v2';
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import BN from 'bn.js';
import type { MarketInfo, OrderbookRow, PublicConfig } from './api';

export const TOKEN = 1_000_000; // 6 decimals
export const BASE_LOTS_PER_TOKEN = 100; // base_lot_size 10_000 → 1 lot = 0.01 token

export interface Addrs {
  programId: PublicKey;
  openbookId: PublicKey;
  musdc: PublicKey;
}

export function addrsFromConfig(c: PublicConfig): Addrs {
  return {
    programId: new PublicKey(c.program_id),
    openbookId: new PublicKey(c.openbook_program_id),
    musdc: new PublicKey(c.musdc_mint),
  };
}

export const ata = (owner: PublicKey, mint: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true);

export const createAtaIx = (payer: PublicKey, owner: PublicKey, mint: PublicKey) =>
  createAssociatedTokenAccountIdempotentInstruction(payer, ata(owner, mint), owner, mint);

// ---------------- prediction_market program ----------------

// Anchor discriminators (sha256("global:<name>")[..8]) from target/idl/prediction_market.json.
const DISCRIMINATORS: Record<string, number[]> = {
  mint_complete_set: [70, 222, 130, 148, 234, 103, 137, 61],
  merge_complete_set: [245, 171, 74, 49, 59, 192, 150, 216],
  redeem: [184, 12, 86, 149, 70, 196, 97, 225],
};

function disc(name: string): Buffer {
  const d = DISCRIMINATORS[name];
  if (!d) throw new Error(`unknown instruction ${name}`);
  return Buffer.from(d);
}

const u64 = (n: bigint | number) => new BN(n.toString()).toArrayLike(Buffer, 'le', 8);
const i64 = (n: bigint | number) => new BN(n.toString()).toTwos(64).toArrayLike(Buffer, 'le', 8);

function setIx(name: string, a: Addrs, m: MarketInfo, user: PublicKey, data: Buffer): TransactionInstruction {
  const yes = new PublicKey(m.yes_mint!);
  const no = new PublicKey(m.no_mint!);
  return new TransactionInstruction({
    programId: a.programId,
    keys: [
      { pubkey: user, isSigner: true, isWritable: false },
      { pubkey: new PublicKey(m.market_pda!), isSigner: false, isWritable: false },
      { pubkey: yes, isSigner: false, isWritable: true },
      { pubkey: no, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(m.vault!), isSigner: false, isWritable: true },
      { pubkey: ata(user, a.musdc), isSigner: false, isWritable: true },
      { pubkey: ata(user, yes), isSigner: false, isWritable: true },
      { pubkey: ata(user, no), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc(name), data]),
  });
}

/** ATAs for mUSDC/YES/NO (idempotent) — prepend to any trade or set instruction. */
export function ensureAtasIxs(a: Addrs, m: MarketInfo, user: PublicKey): TransactionInstruction[] {
  return [a.musdc, new PublicKey(m.yes_mint!), new PublicKey(m.no_mint!)].map((mint) => createAtaIx(user, user, mint));
}

export const mintSetIx = (a: Addrs, m: MarketInfo, user: PublicKey, amount: bigint) =>
  setIx('mint_complete_set', a, m, user, u64(amount));
export const mergeSetIx = (a: Addrs, m: MarketInfo, user: PublicKey, amount: bigint) =>
  setIx('merge_complete_set', a, m, user, u64(amount));
export const redeemIx = (a: Addrs, m: MarketInfo, user: PublicKey, yes: bigint, no: bigint) =>
  setIx('redeem', a, m, user, Buffer.concat([u64(yes), u64(no)]));

// ---------------- OpenBook v2 ----------------

export interface BookAddrs {
  market: PublicKey;
  bids: PublicKey;
  asks: PublicKey;
  eventHeap: PublicKey;
  baseMint: PublicKey;
}

export function bookAddrs(row: OrderbookRow, baseMint: string): BookAddrs {
  return {
    market: new PublicKey(row.ob_market),
    bids: new PublicKey(row.bids),
    asks: new PublicKey(row.asks),
    eventHeap: new PublicKey(row.event_heap),
    baseMint: new PublicKey(baseMint),
  };
}

const PLACE_TAKE_ORDER = Buffer.from([3, 44, 71, 3, 26, 199, 203, 85]); // sha256("global:place_take_order")[..8]

/** Immediate-or-cancel take order; fills settle straight into the user's ATAs. */
export function placeTakeOrderIx(
  a: Addrs,
  b: BookAddrs,
  user: PublicKey,
  side: 'buy' | 'sell',
  limitCents: number,
  baseLots: number,
  /** buys: never spend more than this (mUSDC), whatever the book does before the order lands */
  maxSpend?: number,
): TransactionInstruction {
  const authority = PublicKey.findProgramAddressSync([Buffer.from('Market'), b.market.toBuffer()], a.openbookId)[0];
  // quote lots are 0.0001 mUSDC (base lot 0.01 share × 1¢)
  const maxQuote =
    side === 'buy'
      ? Math.min(baseLots * limitCents, maxSpend !== undefined ? Math.floor(maxSpend * 10_000) : Infinity)
      : baseLots * 100;
  const data = Buffer.concat([
    PLACE_TAKE_ORDER,
    Buffer.from([side === 'buy' ? 0 : 1]), // Side
    i64(limitCents), // price_lots == cents
    i64(baseLots),
    i64(maxQuote),
    Buffer.from([1]), // PlaceOrderType::ImmediateOrCancel
    Buffer.from([10]), // limit
  ]);
  const none = { pubkey: a.openbookId, isSigner: false, isWritable: false };
  return new TransactionInstruction({
    programId: a.openbookId,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: user, isSigner: true, isWritable: true }, // penalty payer
      { pubkey: b.market, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: false, isWritable: false },
      { pubkey: b.bids, isSigner: false, isWritable: true },
      { pubkey: b.asks, isSigner: false, isWritable: true },
      { pubkey: ata(authority, b.baseMint), isSigner: false, isWritable: true },
      { pubkey: ata(authority, a.musdc), isSigner: false, isWritable: true },
      { pubkey: b.eventHeap, isSigner: false, isWritable: true },
      { pubkey: ata(user, b.baseMint), isSigner: false, isWritable: true },
      { pubkey: ata(user, a.musdc), isSigner: false, isWritable: true },
      none, // oracle_a
      none, // oracle_b
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      none, // open_orders_admin
    ],
    data,
  });
}

// ---------------- reads ----------------

export interface Level {
  price: number; // dollars (0.01..0.99)
  size: number; // tokens
}
export interface L2 {
  bids: Level[];
  asks: Level[];
}

let obClient: OpenBookV2Client | null = null;
function client(conn: Connection, openbookId: PublicKey): OpenBookV2Client {
  if (!obClient) {
    // Read-only provider: the wallet is never asked to sign.
    const kp = Keypair.generate();
    const wallet = {
      publicKey: kp.publicKey,
      signTransaction: async <T>(t: T) => t,
      signAllTransactions: async <T>(t: T[]) => t,
    };
    const provider = new AnchorProvider(conn, wallet as never, { commitment: 'confirmed' });
    obClient = new OpenBookV2Client(provider, openbookId);
  }
  return obClient;
}

export async function loadL2(conn: Connection, openbookId: PublicKey, market: PublicKey, depth = 12): Promise<L2> {
  const m = await Market.load(client(conn, openbookId), market);
  await m.loadOrderBook();
  const toLevels = (rows: [number, number, BN, BN][]) => rows.map(([price, size]) => ({ price, size }));
  return { bids: toLevels(m.bids!.getL2(depth)), asks: toLevels(m.asks!.getL2(depth)) };
}

export async function tokenBalance(conn: Connection, owner: PublicKey, mint: PublicKey): Promise<number> {
  try {
    const r = await conn.getTokenAccountBalance(ata(owner, mint), 'confirmed');
    return Number(r.value.amount) / TOKEN;
  } catch {
    return 0;
  }
}

/** Walk the book: average fill price + filled size for a take order of `size` tokens. */
export function estimateFill(levels: Level[], size: number, limit: number, side: 'buy' | 'sell') {
  let remaining = size;
  let cost = 0;
  for (const l of levels) {
    if (remaining <= 0) break;
    if (side === 'buy' ? l.price > limit : l.price < limit) break;
    const take = Math.min(remaining, l.size);
    cost += take * l.price;
    remaining -= take;
  }
  const filled = size - remaining;
  // worst: the price of the last level the order reaches
  let worst = 0;
  let left = filled;
  for (const l of levels) {
    if (left <= 1e-9) break;
    worst = l.price;
    left -= l.size;
  }
  return { filled, avgPrice: filled > 0 ? cost / filled : 0, total: cost, worst };
}

export const mid = (l: L2): number | null =>
  l.bids.length && l.asks.length ? (l.bids[0].price + l.asks[0].price) / 2 : l.bids[0]?.price ?? l.asks[0]?.price ?? null;

export function newTx(ixs: TransactionInstruction[]): Transaction {
  return new Transaction().add(...ixs);
}

