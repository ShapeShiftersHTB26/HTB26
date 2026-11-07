use anchor_lang::prelude::*;

#[constant]
pub const CONFIG_SEED: &[u8] = b"config";

#[constant]
pub const MARKET_SEED: &[u8] = b"market";

#[constant]
pub const YES_MINT_SEED: &[u8] = b"yes";

#[constant]
pub const NO_MINT_SEED: &[u8] = b"no";

#[constant]
pub const VAULT_SEED: &[u8] = b"vault";

/// YES / NO tokens use the same decimals as mUSDC so 1 token == 1 mUSDC at payout.
#[constant]
pub const OUTCOME_DECIMALS: u8 = 6;
