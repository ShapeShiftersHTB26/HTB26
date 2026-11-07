use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::{
    constants::*,
    error::MarketError,
    events::MarketCreated,
    state::{Config, Market, Outcome},
};

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct InitializeMarket<'info> {
    #[account(mut, address = config.admin)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(address = config.collateral_mint)]
    pub collateral_mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        payer = admin,
        space = 8 + Market::INIT_SPACE,
        seeds = [MARKET_SEED, id.to_le_bytes().as_ref()],
        bump
    )]
    pub market: Box<Account<'info, Market>>,
    #[account(
        init,
        payer = admin,
        seeds = [YES_MINT_SEED, market.key().as_ref()],
        bump,
        mint::decimals = OUTCOME_DECIMALS,
        mint::authority = market,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        payer = admin,
        seeds = [NO_MINT_SEED, market.key().as_ref()],
        bump,
        mint::decimals = OUTCOME_DECIMALS,
        mint::authority = market,
    )]
    pub no_mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        payer = admin,
        seeds = [VAULT_SEED, market.key().as_ref()],
        bump,
        token::mint = collateral_mint,
        token::authority = market,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_market(
    ctx: Context<InitializeMarket>,
    id: u64,
    resolution_time: i64,
) -> Result<()> {
    require!(
        resolution_time > Clock::get()?.unix_timestamp,
        MarketError::InvalidResolutionTime
    );

    let market = &mut ctx.accounts.market;
    market.id = id;
    market.collateral_mint = ctx.accounts.collateral_mint.key();
    market.yes_mint = ctx.accounts.yes_mint.key();
    market.no_mint = ctx.accounts.no_mint.key();
    market.vault = ctx.accounts.vault.key();
    market.resolution_time = resolution_time;
    market.outcome = Outcome::Unresolved;
    market.resolved_at = 0;
    market.bump = ctx.bumps.market;

    emit!(MarketCreated {
        market: market.key(),
        id,
        yes_mint: market.yes_mint,
        no_mint: market.no_mint,
        resolution_time,
    });
    Ok(())
}
