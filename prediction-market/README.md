# On-chain Order Book Prediction Market

Binary YES/NO prediction markets on Solana. The UI is the **Predictions** tab of the Backtrace web app (`../web/src/predictions/`). See [PLAN.md](PLAN.md) for the design.

| Part | Path | What it does |
|---|---|---|
| Anchor program | `programs/prediction-market` | mUSDC collateral, mint/merge YES+NO sets, admin resolution, redemption (Void pays 0.5 per token) |
| Order books | OpenBook v2 `opnb2LAf…` (already deployed) | Two books per market: YES/mUSDC and NO/mUSDC. 1¢ ticks, 0.01-token lots, books expire at resolution time |
| Backend | `backend/` (Rust, axum + sqlx) | Create markets (admin or public) + seed both books, resolve, faucet, Postgres records, bot loop (market maker, 5 taker bots, crank) |
| Frontend | `../web/src/predictions/` | Predictions tab: market list, **Create market**, both books, trade YES/NO, positions, mint/merge, redeem. Works with a browser wallet or a built-in burner wallet |

## Run everything in Docker (from the repo root)

```bash
docker compose up -d --build     # first build takes a while (compiles the program + backend)
```

The prediction-market services in the root `docker-compose.yml` all start with `prediction-market-`:

| Service | URL | Notes |
|---|---|---|
| `web` (shared) | http://localhost:5173/#/predictions | **Predictions** tab. Click **Burner wallet**, then **Faucet**, then trade or **Create market** |
| `prediction-market-backend` | http://localhost:8080 | Admin header `x-admin-key: dev-admin-key`. The web app reaches it through the `/pm-api` Vite proxy |
| `prediction-market-validator` | http://localhost:8899 (ws :8900) | Local validator with `prediction_market` + OpenBook v2 loaded at genesis |
| `prediction-market-db` | localhost:5433 | `pm` / `pm` |

On first start the backend:
1. generates the admin and mUSDC mint keypairs (stored in the `prediction-market-keys` volume);
2. airdrops SOL to the admin;
3. creates the mUSDC mint and initializes the program Config;
4. creates **two demo markets**: one closes in 7 days, the other in 15 minutes so you can try resolve + redeem.

The bots start trading right away.

```bash
# resolve the 15-minute demo market once trading has closed (check its id with GET /markets)
curl -X POST localhost:8080/markets/2/resolve -H 'x-admin-key: dev-admin-key' \
  -H 'content-type: application/json' -d '{"outcome":"yes"}'

# full scripted flow against the containers (from web/)
cd web && ADMIN_API_KEY=dev-admin-key npm run pm:e2e
npm run pm:book -- 1             # print both live books of market 1 + bot fair price

# reset chain, database and keys together (other services untouched)
docker compose rm -sfv prediction-market-validator prediction-market-backend prediction-market-db
docker volume rm htb26_prediction-market-ledger htb26_prediction-market-pgdata htb26_prediction-market-keys
```

Notes:
- The chain and the database persist in volumes and stay consistent across `docker compose down` / `up`. Always reset them together (commands above). You also need a reset after changing the program, because programs only load at genesis.
- Agave publishes only x86_64 Linux binaries, so the validator image is `linux/amd64` and runs under Rosetta on Apple Silicon.
- **Two Agave versions:**
  - The program is compiled with **v4.1.1** tooling (Anchor 1.1 needs rustc ≥ 1.89).
  - The test validator runs **v3.0.14**: Agave ≥ 3.1.10 hard-requires io_uring, which neither Rosetta nor Docker's default seccomp profile provides.

  You can change either version with the build args in `docker/validator.Dockerfile`.
- Agave's gossip refuses `0.0.0.0`, so the validator binds to the container's own IP.

## Creating markets

- **Anyone:** `POST /public/markets` with `{question, description?, resolution_time, initial_price_cents?}`. This is what the UI's **Create market** button calls.
  - The admin wallet pays for and seeds both books with the default ladder (5 levels × 50 tokens around the starting price).
  - The question is normalized (trimmed, lowercased, whitespace collapsed) and hashed with sha256 (`query_hash`).
  - Sending the same question again returns the existing market (`created: false`).
  - Later, this hash becomes the on-chain market id. Today the on-chain id is still the database id.
- **Admin:** `POST /markets` with the same body plus custom `seed_sets`, `levels` and `level_size`.

## Running without Docker

Prerequisites: Solana CLI ≥ 2.x (tested with Agave 4.1), Anchor CLI 1.1.x, Rust, Node 20+ and Postgres.

> If `anchor` resolves to the npm shim (`Only x86_64 / Linux distributed in NPM package`), run setup with `ANCHOR=~/.cargo/bin/anchor`.

```bash
# 1. Postgres: a local install, or just the db service
docker compose up -d prediction-market-db     # then DATABASE_URL=postgres://pm:pm@localhost:5433/pm

# 2. Local validator with the real OpenBook v2 cloned from devnet (keep it running)
./scripts/validator.sh

# 3. One-time setup: admin key, mUSDC mint, deploy program, backend/.env, on-chain Config
DATABASE_URL=postgres://pm:pm@localhost:5433/pm ./scripts/setup.sh

# 4. Backend (API on :8080, bots start automatically)
cd backend && cargo run

# 5. Web app (Predictions tab proxies /pm-api to localhost:8080)
cd ../../web && npm install && npm run dev    # http://localhost:5173/#/predictions
```

In the UI, click **Burner wallet** and then **Faucet** (1,000 mUSDC + 0.05 SOL), and trade. Browser wallets work too, as long as they're pointed at the same RPC.

### Tests

```bash
cargo test -p prediction-market                            # program tests (LiteSVM): mint/merge/resolve/redeem/void/invariant
cd ../web && ADMIN_API_KEY=... npm run pm:e2e              # 70s market: trade both books, mint/merge, resolve, redeem
```

## Devnet demo

Run the same steps with `RPC_URL=<devnet RPC> ./scripts/setup.sh`. A free Helius or Triton devnet endpoint holds up better than the public one, because the bots send a transaction every few seconds.

- Fund the admin with about 15 SOL. Each market costs about 4 SOL of rent (two books × three ~90 KB accounts), plus bot funding.
- `target/deploy/prediction_market-keypair.json` sets the program id. It's gitignored, so share it with teammates. Alternatively, run `anchor keys sync` and redeploy.

## API

Admin endpoints need the header `x-admin-key`.

| Method | Path | Auth | |
|---|---|---|---|
| GET | `/health`, `/config` | | Health check; public addresses for the frontend |
| GET | `/markets[?status=active]`, `/markets/:id` | | Markets with both book addresses and `query_hash` |
| GET | `/markets/:id/trades` | | Recent bot orders |
| POST | `/public/markets` | | `{question, description?, resolution_time, initial_price_cents=50}` → `{created, market}`; seeded with liquidity |
| POST | `/markets` | admin | `{question, description?, resolution_time, initial_price_cents=50, seed_sets=1000, levels=5, level_size=50}` |
| POST | `/markets/:id/resolve` | admin | `{outcome: "yes" \| "no" \| "void"}`, only after `resolution_time` |
| POST | `/faucet` | | `{wallet}`: 1,000 mUSDC (+SOL), limited to 1 per wallet per hour |
| POST | `/bots/start`, `/bots/stop` | admin | |
| GET | `/bots/status` | | Bot balances, fair prices, trades in the last minute |

## Notes

- **OpenBook instructions are built by hand** (`backend/src/chain/openbook.rs`, `web/src/predictions/solana.ts`): an 8-byte discriminator plus borsh args, with account order taken from the OpenBook IDL. Its legacy IDL doesn't work with Anchor 1.x codegen.
- **Only the market maker places resting orders.** Users and bots send IOC take orders that settle straight into their token accounts. So the crank only ever passes the admin's open-orders accounts, and users never need an open-orders account.
- **The market maker quotes YES around the fair price `f` and NO around `100 − f`**, with a ≥1¢ spread on each side. That keeps YES ask + NO ask > 100¢ and YES bid + NO bid < 100¢, so the two books stay arbitrage-free.
- **Public creation costs the admin about 4 SOL of rent per market.** That's free on the local validator. Before any public deployment, add rate limiting.
