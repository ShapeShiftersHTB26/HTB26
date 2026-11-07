use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use crate::{constants::*, state::Config};

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    pub collateral_mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_config(ctx: Context<InitializeConfig>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.collateral_mint = ctx.accounts.collateral_mint.key();
    config.bump = ctx.bumps.config;
    Ok(())
}
