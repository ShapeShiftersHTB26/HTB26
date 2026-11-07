pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("5XrnC3eMafJx5ckPKk6Mw5nvX1TJAQ2VaU9xEXR4nLyE");

/// Binary prediction market: mUSDC collateral, YES/NO complete sets, admin resolution.
/// The order books live on OpenBook v2; this program never calls it.
#[program]
pub mod prediction_market {
    use super::*;

    pub fn initialize_config(ctx: Context<InitializeConfig>) -> Result<()> {
        instructions::initialize_config::handle_initialize_config(ctx)
    }

    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        id: u64,
        resolution_time: i64,
    ) -> Result<()> {
        instructions::initialize_market::handle_initialize_market(ctx, id, resolution_time)
    }

    pub fn mint_complete_set(ctx: Context<CompleteSet>, amount: u64) -> Result<()> {
        instructions::complete_set::handle_mint_complete_set(ctx, amount)
    }

    pub fn merge_complete_set(ctx: Context<CompleteSet>, amount: u64) -> Result<()> {
        instructions::complete_set::handle_merge_complete_set(ctx, amount)
    }

    pub fn resolve_market(ctx: Context<ResolveMarket>, outcome: Outcome) -> Result<()> {
        instructions::resolve_market::handle_resolve_market(ctx, outcome)
    }

    pub fn redeem(ctx: Context<CompleteSet>, yes_amount: u64, no_amount: u64) -> Result<()> {
        instructions::redeem::handle_redeem(ctx, yes_amount, no_amount)
    }
}
