#!/usr/bin/env bash
# Local validator with the real OpenBook v2 program cloned from devnet.
# SIMD-0500 (no new SBPF v0-v2 deploys) is active by default on recent local validators but not on
# devnet; deactivate it so `cargo build-sbf`'s default v0 output deploys locally just like on devnet.
set -euo pipefail
exec solana-test-validator --reset \
  --clone-upgradeable-program opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb --url devnet \
  --deactivate-feature B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g \
  "$@"
