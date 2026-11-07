#!/bin/sh
# Programs are loaded at genesis, so they only need passing when the ledger is new.
# The ledger lives in a volume; `docker compose down -v` resets chain + database together.
set -e
LEDGER=/ledger
PROGRAM_ID=${PROGRAM_ID:-5XrnC3eMafJx5ckPKk6Mw5nvX1TJAQ2VaU9xEXR4nLyE}
OPENBOOK_ID=opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb

GENESIS_ARGS=""
if [ ! -f "$LEDGER/genesis.bin" ]; then
  echo "new ledger: loading prediction_market ($PROGRAM_ID) and OpenBook v2 at genesis"
  GENESIS_ARGS="--upgradeable-program $OPENBOOK_ID /programs/openbook_v2.so none \
    --upgradeable-program $PROGRAM_ID /programs/prediction_market.so none"
fi

# Agave's gossip refuses 0.0.0.0, so bind to the container's own IP (Docker port forwarding and
# the backend's `validator:8899` both reach it).
BIND_IP=$(hostname -i | awk '{print $1}')
echo "binding to $BIND_IP"
# shellcheck disable=SC2086
exec solana-test-validator --ledger "$LEDGER" --bind-address "$BIND_IP" --rpc-port 8899 \
  --quiet $GENESIS_ARGS "$@"
