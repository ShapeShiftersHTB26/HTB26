# On-chain Order Book Prediction Market

Binary YES/NO prediction markets on Solana. See [../PLAN.md](../PLAN.md) for the design.

| Part | Path | What it does |
|---|---|---|
| Anchor program | `programs/prediction-market` | mUSDC collateral, mint/merge YES+NO sets, admin resolution, redemption (Void pays 0.5 per token) |
| Order books | OpenBook v2 `opnb2LAf…` (already deployed) | Two books per market: YES/mUSDC and NO/mUSDC. 1¢ ticks, 0.01-token lots, books expire at resolution time |
| Backend | `backend/` (Rust, axum + sqlx) | Create markets + seed both books, resolve, faucet, Postgres records, bot loop (market maker, 5 taker bots, crank) |
| Frontend | `app/` (React + Vite) | Market list, both books, trade YES/NO, positions, mint/merge, redeem. Works with a browser wallet or a built-in burner wallet |

## Quickest: everything in Docker

```bash
docker compose up --build        # first build takes a while (compiles the program + backend)
```

| Service | URL | Notes |
|---|---|---|
| UI | http://localhost:5173 | Click **Burner wallet**, then **Faucet**, then trade |
| API | http://localhost:8080 | Admin header `x-admin-key: dev-admin-key` |
| Solana RPC | http://localhost:8899 (ws :8900) | Local validator with `prediction_market` + OpenBook v2 loaded at genesis |
| Postgres | localhost:5433 | `pm` / `pm` |

On first start the backend:
1. generates the admin and mUSDC mint keypairs (stored in the `keys` volume);
2. airdrops SOL to the admin;
3. creates the mUSDC mint and initializes the program Config;
4. creates **two demo markets**: one closes in 7 days, the other in 15 minutes so you can try resolve + redeem.

The bots start trading right away.

```bash
# resolve the 15-minute demo market once trading has closed (check its id with GET /markets)
curl -X POST localhost:8080/markets/2/resolve -H 'x-admin-key: dev-admin-key' \
  -H 'content-type: application/json' -d '{"outcome":"yes"}'

# full scripted flow against the containers
cd app && ADMIN_API_KEY=dev-admin-key pnpm e2e

docker compose down -v           # reset chain, database and keys together
```

Notes:
- The chain (`ledger`) and the database (`pgdata`) persist in volumes and stay consistent across `docker compose down` / `up`. Always reset them together with `down -v`. You also need `down -v` after changing the program, because programs only load at genesis.
- Agave publishes only x86_64 Linux binaries, so the validator image is `linux/amd64` and runs under Rosetta on Apple Silicon.
- **Two Agave versions:**
  - The program is compiled with **v4.1.1** tooling (Anchor 1.1 needs rustc ≥ 1.89).
  - The test validator runs **v3.0.14**: Agave ≥ 3.1.10 hard-requires io_uring, which neither Rosetta nor Docker's default seccomp profile provides.

  You can change either version with the build args in `docker/validator.Dockerfile`.
- Agave's gossip refuses `0.0.0.0`, so the validator binds to the container's own IP.

## Prerequisites (running without Docker)

Solana CLI ≥ 2.x (tested with Agave 4.1), Anchor CLI 1.1.x, Rust, Node 20+ with pnpm, and Postgres (via `docker compose` or a local install).

> If `anchor` resolves to the npm shim (`Only x86_64 / Linux distributed in NPM package`), run setup with `ANCHOR=~/.cargo/bin/anchor`.

## Run locally (no wallet or paid RPC needed)

```bash
# 1. Postgres
docker compose up -d                      # or use a local Postgres and set DATABASE_URL

# 2. Local validator with the real OpenBook v2 cloned from devnet (keep it running)
./scripts/validator.sh

# 3. One-time setup: admin key, mUSDC mint, deploy program, backend/.env, on-chain Config
./scripts/setup.sh                        # DATABASE_URL=postgres://localhost/pm_dev ./scripts/setup.sh for a local db

# 4. Backend (API on :8080, bots start automatically)
cd backend && cargo run

# 5. Create a market (the admin key is in backend/.env); edit resolution_time first
curl -X POST localhost:8080/markets -H "x-admin-key: $(grep ADMIN_API_KEY backend/.env | cut -d= -f2)" \
  -H 'content-type: application/json' -d @sample-market.json

# 6. Frontend
cd app && pnpm install && pnpm dev        # http://localhost:5173
```

In the UI, click **Burner wallet** and then **Faucet** (1,000 mUSDC + 0.05 SOL), and trade. Browser wallets work too, as long as they're pointed at the same RPC.

### Test the whole flow from the command line

```bash
cargo test -p prediction-market                       # program tests (LiteSVM): mint/merge/resolve/redeem/void/invariant
cd app && ADMIN_API_KEY=... pnpm e2e                  # creates a 70s market, trades both books, mints/merges, resolves, redeems
pnpm book 1                                           # print both live books of market 1 + bot fair price
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
| GET | `/markets[?status=active]`, `/markets/:id` | | Markets with both book addresses |
| GET | `/markets/:id/trades` | | Recent bot orders |
| POST | `/markets` | admin | `{question, description?, resolution_time, initial_price_cents=50, seed_sets=1000, levels=5, level_size=50}` |
| POST | `/markets/:id/resolve` | admin | `{outcome: "yes" \| "no" \| "void"}`, only after `resolution_time` |
| POST | `/faucet` | | `{wallet}`: 1,000 mUSDC (+SOL), limited to 1 per wallet per hour |
| POST | `/bots/start`, `/bots/stop` | admin | |
| GET | `/bots/status` | | Bot balances, fair prices, trades in the last minute |

## Notes

- **OpenBook instructions are built by hand** (`backend/src/chain/openbook.rs`, `app/src/solana.ts`): an 8-byte discriminator plus borsh args, with account order taken from the OpenBook IDL. Its legacy IDL doesn't work with Anchor 1.x codegen.
- **Only the market maker places resting orders.** Users and bots send IOC take orders that settle straight into their token accounts. So the crank only ever passes the admin's open-orders accounts, and users never need an open-orders account.
- **The market maker quotes YES around the fair price `f` and NO around `100 − f`**, with a ≥1¢ spread on each side. That keeps YES ask + NO ask > 100¢ and YES bid + NO bid < 100¢, so the two books stay arbitrage-free.
