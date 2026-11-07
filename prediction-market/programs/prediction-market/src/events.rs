use anchor_lang::prelude::*;

use crate::state::Outcome;

#[event]
pub struct MarketCreated {
    pub market: Pubkey,
    pub id: u64,
    pub yes_mint: Pubkey,
    pub no_mint: Pubkey,
    pub resolution_time: i64,
}

#[event]
pub struct SetMinted {
    pub market: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
}

#[event]
pub struct SetMerged {
    pub market: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Resolved {
    pub market: Pubkey,
    pub outcome: Outcome,
    pub resolved_at: i64,
}

#[event]
pub struct Redeemed {
    pub market: Pubkey,
    pub user: Pubkey,
    pub yes_amount: u64,
    pub no_amount: u64,
    pub payout: u64,
}
