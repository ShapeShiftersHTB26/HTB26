#!/usr/bin/env bash
# One-time setup: admin key, mUSDC mint, program deploy, backend/.env, on-chain Config.
# Usage (from anywhere):  RPC_URL=http://127.0.0.1:8899 ./scripts/setup.sh
#   RPC_URL       default http://127.0.0.1:8899 (local validator); use a devnet RPC for the demo
#   DATABASE_URL  default postgres://pm:pm@localhost:5432/pm (docker compose)
#   ANCHOR        anchor binary to use (default: anchor)
set -euo pipefail
cd "$(dirname "$0")/.."

RPC_URL=${RPC_URL:-http://127.0.0.1:8899}
DATABASE_URL=${DATABASE_URL:-postgres://pm:pm@localhost:5432/pm}
ANCHOR=${ANCHOR:-anchor}

mkdir -p keys
[ -f keys/admin.json ] || solana-keygen new -s --no-bip39-passphrase -o keys/admin.json
ADMIN=$(solana-keygen pubkey keys/admin.json)
echo "admin: $ADMIN"

if [[ "$RPC_URL" == *127.0.0.1* || "$RPC_URL" == *localhost* ]]; then
  solana airdrop 500 "$ADMIN" -u "$RPC_URL" >/dev/null
fi
echo "admin balance: $(solana balance "$ADMIN" -u "$RPC_URL")"

# mUSDC: classic SPL token, 6 decimals, mint authority = admin.
[ -f keys/musdc-mint.json ] || solana-keygen new -s --no-bip39-passphrase -o keys/musdc-mint.json
MUSDC=$(solana-keygen pubkey keys/musdc-mint.json)
if ! spl-token supply "$MUSDC" -u "$RPC_URL" >/dev/null 2>&1; then
  spl-token create-token --decimals 6 --mint-authority "$ADMIN" --fee-payer keys/admin.json \
    -u "$RPC_URL" keys/musdc-mint.json
fi
echo "mUSDC mint: $MUSDC"

# Build + deploy the prediction_market program.
"$ANCHOR" build
solana program deploy target/deploy/prediction_market.so \
  --program-id target/deploy/prediction_market-keypair.json \
  --keypair keys/admin.json -u "$RPC_URL"
PROGRAM_ID=$(solana-keygen pubkey target/deploy/prediction_market-keypair.json)
echo "program: $PROGRAM_ID"

if [ ! -f backend/.env ]; then
  cat > backend/.env <<EOF
RPC_URL=$RPC_URL
DATABASE_URL=$DATABASE_URL
ADMIN_KEYPAIR=../keys/admin.json
MUSDC_MINT=$MUSDC
PROGRAM_ID=$PROGRAM_ID
OPENBOOK_PROGRAM_ID=opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb
ADMIN_API_KEY=$(openssl rand -hex 16)
BIND_ADDR=0.0.0.0:8080
BOT_COUNT=5
BOT_INTERVAL_MS=3000
BOTS_AUTOSTART=true
BOT_KEYS_DIR=../keys/bots
FAUCET_SOL_LAMPORTS=50000000
RUST_LOG=pm_backend=info,tower_http=info
EOF
  echo "wrote backend/.env"
else
  echo "backend/.env exists, not overwriting"
fi

(cd backend && cargo run --quiet -- init-config)
echo "setup done. Next: cd backend && cargo run"
