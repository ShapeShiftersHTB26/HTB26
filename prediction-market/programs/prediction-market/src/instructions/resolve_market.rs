use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::MarketError,
    events::Resolved,
    state::{Config, Market, Outcome},
};

#[derive(Accounts)]
pub struct ResolveMarket<'info> {
    #[account(address = config.admin)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [MARKET_SEED, market.id.to_le_bytes().as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,
}

pub fn handle_resolve_market(ctx: Context<ResolveMarket>, outcome: Outcome) -> Result<()> {
    require!(outcome != Outcome::Unresolved, MarketError::InvalidOutcome);
    let market = &mut ctx.accounts.market;
    require!(!market.is_resolved(), MarketError::AlreadyResolved);

    let now = Clock::get()?.unix_timestamp;
    require!(now >= market.resolution_time, MarketError::TooEarly);

    market.outcome = outcome;
    market.resolved_at = now;

    emit!(Resolved {
        market: market.key(),
        outcome,
        resolved_at: now,
    });
    Ok(())
}
