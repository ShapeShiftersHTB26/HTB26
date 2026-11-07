# On-chain Order Book Prediction Market — Hackathon Plan

Binary (YES/NO) prediction markets on Solana:

- **Anchor program** handles collateral and outcome tokens: mint/merge YES+NO sets, resolution, redemption.
- **OpenBook v2** (already deployed, permissionless market creation) is the on-chain order book. Each question gets **two books: YES/mUSDC and NO/mUSDC**.
- **Mock USDC** (`mUSDC`), minted by the admin wallet, is the only collateral.
- **Rust backend** (one binary): REST API for market creation with auto-seeded liquidity on both books, Postgres records, faucet, and a background task that runs a market maker, random trader bots and the event crank.
- **React frontend**: one Polymarket-style view per question, showing both books.

Keep it simple: one Rust service, one Postgres container, no queues, no indexer, no microservices.

---

## 1. Architecture

```text
                    ┌──────────────────────────────┐
   React app ──────▶│  Rust backend (axum + tokio) │──────▶ Postgres
   (wallet,         │  ├─ REST API                 │        (markets, orderbooks,
    OpenBook TS     │  │   markets / faucet / bots │         bot_trades, faucet_claims)
    client)         │  └─ background task          │
       │            │      ├─ market maker         │
       │            │      ├─ taker bots           │
       │            │      └─ crank                │
       │            └──────────────┬───────────────┘
       │                           │  admin keypair, bot keypairs
       ▼                           ▼
┌──────────────────────────── Solana ─────────────────────────────┐
│  prediction_market program        OpenBook v2 (opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb) │
│  - Config (admin, mUSDC)          per question:                 │
│  - Market PDA + vault               ├─ YES/mUSDC market         │
│  - YES/NO mints (PDA auth)          └─ NO/mUSDC  market         │
│  mUSDC SPL mint (authority = admin wallet)                      │
└─────────────────────────────────────────────────────────────────┘
```

**The program never calls OpenBook.** Anything that needs both programs is done by putting instructions from each into **one transaction** on the client. No CPI means no dependency clash between Anchor and OpenBook.

---

## 2. Key design decisions

| Decision | Choice | Why |
|---|---|---|
| Order book | OpenBook v2, existing deployment | Permissionless `create_market`, Anchor IDL, market expiry built in. Nothing to deploy. |
| Books per question | **YES/mUSDC and NO/mUSDC** | Users trade either outcome directly. Trade-off: liquidity is split across two books, so the market maker quotes both and keeps them consistent (§8.2). |
| Keeping the two books consistent | Market maker quotes both books around one shared fair price, plus mint/merge | YES ask + NO ask always > 100¢ and YES bid + NO bid always < 100¢, so the books never offer free money (§5.1). |
| Halting trading | OpenBook `time_expiry = resolution_time` on both books | The books stop taking orders on their own at resolution time, with no extra transaction. |
| Who places resting orders | Market-maker bot only (MVP) | Users and taker bots use `place_take_order`. That means no open-orders account for users, and the crank only ever needs known maker accounts (§8.4). |
| Resolution | Admin wallet via backend endpoint | Fine for a hackathon. An oracle is out of scope. |
| Collateral | `mUSDC`, classic SPL Token, 6 decimals | Admin can mint freely for seeding, bots and the faucet. Avoid Token-2022 for compatibility. |

---

## 3. Tokens and the mUSDC mock

| Token | Program | Decimals | Mint authority |
|---|---|---:|---|
| mUSDC | SPL Token | 6 | Admin wallet |
| YES (per market) | SPL Token | 6 | Market PDA |
| NO (per market) | SPL Token | 6 | Market PDA |

Invariant while a market is unresolved: `vault mUSDC == YES supply == NO supply`. Make this a test.

One-time setup (`scripts/setup.sh`):

```bash
solana-keygen new -o keys/admin.json --no-bip39-passphrase
solana-keygen new -o keys/musdc-mint.json --no-bip39-passphrase   # optional: `solana-keygen grind --starts-with USD:1`
solana config set --keypair keys/admin.json

spl-token create-token --decimals 6 --mint-authority keys/admin.json keys/musdc-mint.json
# then: anchor deploy, and call initialize_config(collateral_mint = mUSDC)
```

`keys/` is gitignored. The backend loads `keys/admin.json` and is the only thing that mints mUSDC.

---

## 4. Anchor program (`prediction_market`)

### Accounts

```rust
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub collateral_mint: Pubkey,   // mUSDC, pinned so markets can't use fake collateral
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub id: u64,                   // = Postgres markets.id
    pub yes_mint: Pubkey,
    pub no_mint: Pubkey,
    pub vault: Pubkey,             // mUSDC token account owned by the Market PDA
    pub resolution_time: i64,
    pub outcome: Outcome,
    pub resolved_at: i64,          // 0 = unresolved
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum Outcome { Unresolved, Yes, No, Void }
```

PDAs: `config = ["config"]`, `market = ["market", id.to_le_bytes()]`, `yes_mint = ["yes", market]`, `no_mint = ["no", market]`, `vault = ["vault", market]`. The Market PDA is mint authority for YES/NO and owner of the vault.

The program does not know about the order books. Their addresses live only in Postgres.

### Instructions

| Instruction | Signer | Effect |
|---|---|---|
| `initialize_config(collateral_mint)` | admin | One time. |
| `initialize_market(id, resolution_time)` | `config.admin` | Creates the Market PDA, YES/NO mints and vault. |
| `mint_complete_set(amount)` | anyone | Unresolved only. Moves `amount` mUSDC into the vault and mints `amount` YES + `amount` NO. |
| `merge_complete_set(amount)` | anyone | Burns `amount` YES + NO and pays out `amount` mUSDC. Allowed at any time. |
| `resolve_market(outcome)` | `config.admin` | Requires `now >= resolution_time`, not already resolved, and `outcome != Unresolved`. |
| `redeem(yes_amount, no_amount)` | anyone | Burns both amounts and pays according to the outcome. |

```rust
let payout = match market.outcome {
    Outcome::Yes  => yes_amount,
    Outcome::No   => no_amount,
    Outcome::Void => yes_amount.checked_add(no_amount).unwrap() / 2, // 0.5 per token, either side
    Outcome::Unresolved => return err!(MarketError::NotResolved),
};
```

Admin checks use `has_one`/`address = config.admin` constraints. Emit Anchor events for `MarketCreated`, `SetMinted`, `SetMerged`, `Resolved` and `Redeemed`.

---

## 5. OpenBook v2 market parameters

**Two OpenBook markets per question**, with the same parameters except the base mint:

| Param | YES book | NO book | Meaning |
|---|---|---|---|
| base mint | YES mint | NO mint | |
| quote mint | mUSDC | mUSDC | |
| `name` | `"PM-42-YES"` | `"PM-42-NO"` | Max 16 bytes |
| `base_lot_size` | `10_000` | `10_000` | 1 lot = 0.01 token (min order) |
| `quote_lot_size` | `100` | `100` | 0.0001 mUSDC |
| `maker_fee` / `taker_fee` | `0` / `0` | `0` / `0` | |
| `time_expiry` | `resolution_time` | `resolution_time` | Books stop taking orders at resolution |
| `oracle_a` / `oracle_b` | none | none | |
| `open_orders_admin` | none | none | Anyone can trade |
| `consume_events_admin` | none | none | Anyone can crank |
| `close_market_admin` | admin | admin | Can `set_market_expired` early and `close_market` to reclaim rent |
| `collect_fee_admin` | admin | admin | |

Price math (both tokens have 6 decimals): `price = price_lots × quote_lot_size / base_lot_size = price_lots / 100`.
So **`price_lots` is the price in cents**, and the valid range is `1..=99` on both books. Order size in base lots is `tokens × 100`.

**Rent:** each OpenBook market needs bids, asks and an event heap of ~90 KB each, about 0.63 SOL apiece. That is ~2 SOL per book, so **about 4 SOL per question**. Do development on a local validator. On devnet create only 2–3 demo questions and call `close_market` on both books afterwards to get the rent back.

### 5.1 Keeping the two books consistent

Prices on the two books are tied together by mint and merge:

- If **YES ask + NO ask < 100¢**, anyone can buy both and merge them for 100¢, a risk-free profit.
- If **YES bid + NO bid > 100¢**, anyone can mint a set for 100¢ and sell both sides for more.

In the MVP the market maker is the only party placing resting orders. It quotes YES around fair price `f` and NO around `100 − f` with at least 1¢ on each side, so:

```text
YES ask + NO ask = (f+1) + (100−f+1) = 102 > 100   ✓
YES bid + NO bid = (f−1) + (100−f−1) =  98 < 100   ✓
```

Neither opportunity ever appears, so **no arbitrage bot is needed in the MVP**. One becomes useful once users can place their own limit orders (§13).

---

## 6. Trading flows

All of these are single atomic transactions built in the frontend or by the bots:

| User action | Instructions in one transaction |
|---|---|
| Buy YES | `place_take_order(Bid, limit)` on the **YES book** |
| Sell YES | `place_take_order(Ask, limit)` on the **YES book** |
| Buy NO | `place_take_order(Bid, limit)` on the **NO book** |
| Sell NO | `place_take_order(Ask, limit)` on the **NO book** |
| Mint set | `mint_complete_set(x)` (shown in an "advanced" panel) |
| Merge set | `merge_complete_set(x)` |
| Redeem | `redeem(yes, no)` after resolution |

`place_take_order` settles straight into the user's token accounts, so users need **no open-orders account and no `settle_funds`**.

UI display:

```text
Will X happen by Dec 31?          Implied probability: 43%

YES book                NO book
bid 42¢ / ask 44¢       bid 56¢ / ask 58¢
```

Implied probability = average of the YES mid and `100 − NO mid`. The two match whenever the market maker's quotes are consistent.

---

## 7. Postgres schema

`backend/migrations/0001_init.sql` (sqlx migrations; run automatically on startup):

```sql
create table markets (
  id                  bigserial primary key,        -- also the on-chain Market id seed
  question            text not null,
  description         text,
  status              text not null default 'pending',  -- pending | active | resolved | failed
  outcome             text,                             -- yes | no | void
  resolution_time     timestamptz not null,
  initial_price_cents int  not null,                    -- initial YES price; NO starts at 100 - this
  seed_sets           bigint not null,                  -- complete sets minted for liquidity (base units)
  levels              int  not null,                    -- ladder shape, reused by the market maker
  level_size          bigint not null,                  -- tokens per ladder level
  market_pda          text unique,
  yes_mint            text,
  no_mint             text,
  vault               text,
  create_txs          text[] not null default '{}',
  error               text,
  created_at          timestamptz not null default now(),
  resolved_at         timestamptz
);

-- one row per OpenBook market: two per question
create table orderbooks (
  market_id           bigint not null references markets(id),
  outcome             text   not null check (outcome in ('yes', 'no')),
  ob_market           text   not null unique,
  bids                text   not null,
  asks                text   not null,
  event_heap          text   not null,
  admin_open_orders   text   not null,              -- market maker's open-orders account on this book
  primary key (market_id, outcome)
);

create table bot_trades (
  id          bigserial primary key,
  market_id   bigint not null references markets(id),
  book        text   not null,        -- yes | no
  bot         text   not null,        -- bot pubkey
  side        text   not null,        -- buy | sell
  size_lots   bigint not null,
  limit_cents int    not null,
  tx          text   not null,
  created_at  timestamptz not null default now()
);

create table faucet_claims (
  wallet      text primary key,
  last_claim  timestamptz not null
);
```

`GET /markets/:id` joins `markets` with both `orderbooks` rows.

---

## 8. Rust backend (`backend/`)

One binary. Stack: `axum`, `tokio`, `sqlx` (postgres), `solana-client` (nonblocking), `anchor-lang` (`declare_program!`), `serde`, `tracing`, `dotenvy`.

**Instruction building (as implemented):** our program's instructions come from the program crate itself (path dependency with `no-entrypoint`). The ~9 OpenBook instructions are hand-built in `chain/openbook.rs`: 8-byte discriminator `sha256("global:<name>")[..8]` + borsh args, with account order copied from OpenBook's IDL. Its legacy IDL doesn't work with Anchor 1.x codegen.

Keep the backend as its **own Cargo project**, outside the Anchor workspace, so dependency versions don't fight.

### Layout

```text
backend/
├── Cargo.toml
├── migrations/0001_init.sql
├── idls/{prediction_market.json, openbook_v2.json}
└── src/
    ├── main.rs          # load config, connect db, run migrations, spawn bots task, serve axum
    ├── config.rs        # env vars
    ├── db.rs            # sqlx queries
    ├── routes.rs        # handlers
    ├── chain/
    │   ├── mod.rs       # RpcClient, send_and_confirm helper, ATA helpers
    │   ├── program.rs   # prediction_market ix builders
    │   └── openbook.rs  # create_market, place_orders, place_take_order, consume_events, settle_funds, expire/close
    └── bots/
        ├── mod.rs       # BotManager: start/stop flag, tokio::spawn loop, shared fair-value map
        ├── mm.rs        # market maker (admin wallet), quotes both books
        ├── takers.rs    # random trader bots
        └── crank.rs     # consume_events on both books
```

Write the book-level helpers once, taking an `Orderbook { ob_market, bids, asks, event_heap, base_mint, ... }` struct, and call them for YES and NO. Nothing in `chain/openbook.rs` should be YES- or NO-specific.

### Config (`.env`)

```text
RPC_URL=http://127.0.0.1:8899        # devnet: use a free Helius/Triton devnet RPC, not the public one
DATABASE_URL=postgres://pm:pm@localhost:5432/pm
ADMIN_KEYPAIR=../keys/admin.json
MUSDC_MINT=<pubkey>
PROGRAM_ID=<prediction_market program id>
OPENBOOK_PROGRAM_ID=opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb
ADMIN_API_KEY=<random string>
BOT_COUNT=5
BOT_INTERVAL_MS=3000
BOTS_AUTOSTART=true
```

### API

Admin endpoints require the header `x-admin-key: $ADMIN_API_KEY`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | | |
| GET | `/markets` | | List markets with both book addresses (frontend reads this) |
| GET | `/markets/:id` | | Market + addresses for both books |
| POST | `/markets` | admin | Create a market and seed both books (below) |
| POST | `/markets/:id/resolve` | admin | `{ "outcome": "yes" \| "no" \| "void" }` |
| POST | `/faucet` | | `{ "wallet": "<pubkey>" }` → mint 1,000 mUSDC (+0.05 SOL on devnet). Limit 1 per wallet per hour via `faucet_claims`. |
| POST | `/bots/start`, `/bots/stop` | admin | Toggle the bot loop |
| GET | `/bots/status` | | Running? bot pubkeys, balances, trades in the last minute |

### `POST /markets`: create and seed

Request:

```json
{
  "question": "Will X happen by Dec 31?",
  "description": "Resolves YES if ...",
  "resolution_time": "2026-12-31T23:59:59Z",
  "initial_price_cents": 50,
  "seed_sets": 1000,
  "levels": 5,
  "level_size": 50
}
```

Let `p = initial_price_cents`. Each step is one transaction; split a step if it hits the size limit.

1. `INSERT ... status='pending' RETURNING id`. This id is the on-chain market id.
2. **Tx A:** `prediction_market::initialize_market(id, resolution_time)`.
3. **Tx B1:** create the YES book: `system::create_account` for bids, asks and the event heap (OpenBook-owned, sizes as in the OpenBook TS client's `createMarketIx`), then `create_market` with base = YES. The market account is a fresh keypair.
4. **Tx B2:** create the NO book the same way, with base = NO.
5. **Tx C:** fund the seed. Use `spl_token::mint_to` to mint mUSDC to the admin. It needs `seed_sets` for the sets, plus enough to back the bid ladders on both books. Then call `mint_complete_set(seed_sets)`, which gives the admin YES and NO inventory for the ask ladders.
6. **Tx D:** admin open orders. Create the admin's `open_orders_indexer` once (it is per owner, so skip it if it exists), then `create_open_orders_account` for the YES book and for the NO book.
7. **Tx E1:** YES ladder with `place_orders`: asks at `p+1 … p+levels`, bids at `p−1 … p−levels`, each `level_size` tokens.
8. **Tx E2:** NO ladder with `place_orders`: asks at `(100−p)+1 …`, bids at `(100−p)−1 …`, same sizes. Clamp all prices to 1–99.
9. In one DB transaction: insert both `orderbooks` rows, then `UPDATE markets SET status='active'` with the addresses and transaction signatures. On any error, set `status='failed'` and store `error`.
10. Register the market with the bot manager, with fair value = `p`.

### `POST /markets/:id/resolve`

- If `now < resolution_time`, return 400. (Optional stretch: allow early resolution by putting `set_market_expired` for both books in the same transaction.)
- **Tx:** `resolve_market(outcome)`. Both books are already expired through `time_expiry`.
- Bot manager: stop quoting the market, cancel the market maker's orders on both books, and `settle_funds` on both.
- `UPDATE status='resolved', outcome, resolved_at`.

### 8.1 Bot task (spawned at startup when `BOTS_AUTOSTART=true`)

One `tokio::spawn` loop, controlled by an `Arc<AtomicBool>`. Every `BOT_INTERVAL_MS` it runs the parts below in order. Process markets one at a time; no parallelism is needed.

**Fair value per market** (kept in memory, reset from the DB on restart): one number `f` = fair YES price in cents. It moves as a bounded random walk, `f += normal(0, 1.0)` per tick, clamped to 5–95. The fair NO price is always `100 − f`. Bots trade toward these prices with noise, so the price drifts and the chart looks alive.

### 8.2 Market maker (`mm.rs`, admin wallet)

Every ~10 s per active market:

1. `settle_funds` on both books to pull filled proceeds back to the admin's token accounts.
2. Rebalance inventory:
   - If admin YES or NO < 2 × `levels × level_size`: mint mUSDC and `mint_complete_set` to top up both.
   - If admin YES and NO are both well above target: `merge_complete_set(min(yes, no) − target)` to free mUSDC.
3. `cancel_all_and_place_orders` on the YES book around `round(f)`.
4. `cancel_all_and_place_orders` on the NO book around `100 − round(f)`.

Steps 3 and 4 use the same ladder shape as seeding. That is what keeps the two books consistent (§5.1). Both re-quotes together come to 1,780 bytes, over the 1,232-byte transaction limit, so they go as two transactions back to back.

### 8.3 Taker bots (`takers.rs`)

- On startup, load or generate `BOT_COUNT` keypairs in `keys/bots/*.json`. The admin tops each up when it is low: 0.1 SOL and 10,000 mUSDC. Each bot also calls `mint_complete_set(500)` once so it holds YES and NO to sell.
- Each tick: pick a random active market and a random bot, then a weighted random action:

| Weight | Action | Book | Limit price |
|---:|---|---|---|
| 30% | buy YES | YES | `f + U(0, 3)` ¢ |
| 20% | sell YES (if it holds YES) | YES | `f − U(0, 3)` ¢ |
| 30% | buy NO | NO | `(100 − f) + U(0, 3)` ¢ |
| 20% | sell NO (if it holds NO) | NO | `(100 − f) − U(0, 3)` ¢ |

- Size: random 1–20 tokens. If nothing crosses, the order just doesn't fill. Log each sent transaction to `bot_trades`.
- If a bot runs low on YES or NO, it mints another set on its next turn.

### 8.4 Crank (`crank.rs`)

Every tick, for **each book** of each active market: `consume_events(limit = 10)`, passing that book's `admin_open_orders` account as a remaining account.
This works because in the MVP **only the market maker places resting orders**. Every fill's maker is the admin, so the crank never has to read the event heap.

---

## 9. Frontend (Predictions tab: `web/src/predictions/` in the Backtrace web app)

Anyone can create a market from the UI (**Create market** → `POST /public/markets`). The backend seeds both books, and the same question returns the existing market (`query_hash`).

React (Vite or Next.js), `@solana/wallet-adapter`, `@coral-xyz/anchor` with the program IDL, and `@openbook-dex/openbook-v2` to read both books.

- **Markets list:** from `GET /markets`. Shows the question, implied probability and time to resolution.
- **Market page:**
  - The YES and NO books side by side (depth view).
  - Buy/Sell YES and Buy/Sell NO buttons with an amount, each sending a take order to its own book, with an estimated fill from walking that book. Enforces prices of 1–99¢.
  - Positions: YES/NO/mUSDC balances.
  - "Advanced" panel with Mint set / Merge set.
- **Faucet button:** `POST /faucet`.
- **Burner wallet:** a keypair kept in localStorage, so the demo works without a wallet extension on a local validator or devnet.
- **Resolved state:** shows the outcome and a Redeem button.
- **Price chart (optional):** poll both mids every few seconds on the client, or draw it from `bot_trades`.

---

## 10. Repo layout and running it

The `prediction market/` folder name contains a space, which breaks some scripts. Rename it to `prediction-market/`.

```text
prediction-market/
├── Anchor.toml
├── programs/prediction_market/
├── tests/                      # anchor tests: mint/merge/resolve/redeem/void + vault invariant
├── backend/                    # separate Cargo project
├── scripts/setup.sh
├── docker-compose.yml          # postgres only
└── keys/                       # gitignored
```

```yaml
# docker-compose.yml
services:
  db:
    image: postgres:16
    environment: { POSTGRES_USER: pm, POSTGRES_PASSWORD: pm, POSTGRES_DB: pm }
    ports: ["5432:5432"]
```

Local dev loop:

```bash
docker compose up -d
solana-test-validator --reset \
  --clone-upgradeable-program opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb --url devnet
anchor build && anchor deploy
./scripts/setup.sh                       # admin key, mUSDC mint, initialize_config
cd backend && cargo run                  # migrations, API on :8080, bots autostart
curl -X POST localhost:8080/markets -H "x-admin-key: $ADMIN_API_KEY" -d @sample-market.json
cd ../app && pnpm dev
```

Devnet demo: same steps against a devnet RPC. Fund the admin with ~15 SOL: about 4 SOL per question for 2–3 questions, plus bot funding.

---

## 11. Build order

1. Anchor program + tests (mint, merge, resolve, redeem, void, vault invariant).
2. `setup.sh`: mUSDC mint + `initialize_config`.
3. Backend skeleton: config, db, migrations, `/health`, `/markets` GET.
4. `chain/openbook.rs`: get `create_market` + `place_orders` working for one book on the local validator. **This is the riskiest step, so do it early.** The second book reuses the same code.
5. `POST /markets` end to end: both books, seeded.
6. Frontend: market list, both book views, Buy/Sell YES and NO.
7. Faucet, mint/merge panel, redeem.
8. Bot task: crank → market maker (both books) → takers.
9. Resolve endpoint and resolved UI state.
10. Devnet deploy, 2–3 demo questions, rehearse the demo.

## 12. Verified during implementation

- OpenBook instructions are hand-built; the legacy IDL wasn't usable with Anchor 1.x.
- Account sizes: bookside 90,952 bytes, event heap 91,288 bytes.
- `time_expiry` stops the market maker and taker bots; post-resolution cancel and settle still work.
- `place_orders` sizes each order in **quote** lots, so the size sent is `base_lots × price_lots`.
- A take order's quote cap must stay ≤ `i64::MAX / quote_lot_size`.
- The two re-quotes don't fit in one transaction, so they're sent back to back.
- Local validators on Agave 4.x activate SIMD-0500, which blocks new SBPF v0 deploys. Devnet doesn't have it yet. `scripts/validator.sh` deactivates it locally.
- Tested on a local validator with the real OpenBook program cloned from devnet: `pnpm e2e` covers create, faucet, trading both books, mint/merge, resolve and redeem.

## 13. Stretch goals (only if time remains)

- **Smart routing for users:** buying NO can also be done as "mint a set, then sell the YES". The UI compares that against buying directly on the NO book and uses whichever is cheaper. This combines liquidity from both books.
- **Arbitrage bot:** reads the top of both books and mints/merges whenever YES ask + NO ask < 100¢ or YES bid + NO bid > 100¢. Needed once users can place limit orders.
- **User limit orders:** need user open-orders accounts plus a crank that reads makers from the event heap.
- Record fills from the event heap into a `fills` table for real price history.
- Early resolution (`set_market_expired`), `prune_orders` and `close_market` on both books to reclaim rent.
- Markets created from data, e.g. load the UK Land Registry `pp-*.csv` into Postgres with `COPY` and resolve house-price markets from a SQL query.

## Out of scope

Oracles and dispute windows, fees, multi-outcome markets, Token-2022, separate indexer services, Kubernetes or any infrastructure beyond one binary + Postgres.
