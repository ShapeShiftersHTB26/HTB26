use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};

use crate::{
    constants::*,
    error::MarketError,
    events::{SetMerged, SetMinted},
    state::Market,
};

/// Accounts shared by `mint_complete_set`, `merge_complete_set` and `redeem`.
#[derive(Accounts)]
pub struct CompleteSet<'info> {
    pub user: Signer<'info>,
    #[account(
        seeds = [MARKET_SEED, market.id.to_le_bytes().as_ref()],
        bump = market.bump,
        has_one = yes_mint,
        has_one = no_mint,
        has_one = vault,
    )]
    pub market: Box<Account<'info, Market>>,
    #[account(mut)]
    pub yes_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub no_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = market.collateral_mint,
        token::authority = user,
    )]
    pub user_collateral: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = yes_mint, token::authority = user)]
    pub user_yes: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = no_mint, token::authority = user)]
    pub user_no: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

impl<'info> CompleteSet<'info> {
    fn market_seeds(&self) -> [Vec<u8>; 3] {
        [
            MARKET_SEED.to_vec(),
            self.market.id.to_le_bytes().to_vec(),
            vec![self.market.bump],
        ]
    }

    /// Pay `amount` mUSDC from the vault to the user (signed by the Market PDA).
    pub fn pay_out(&self, amount: u64) -> Result<()> {
        if amount == 0 {
            return Ok(());
        }
        let seeds = self.market_seeds();
        let seed_refs: [&[u8]; 3] = [&seeds[0], &seeds[1], &seeds[2]];
        let signer: &[&[&[u8]]] = &[&seed_refs];
        token::transfer(
            CpiContext::new_with_signer(
                self.token_program.key(),
                Transfer {
                    from: self.vault.to_account_info(),
                    to: self.user_collateral.to_account_info(),
                    authority: self.market.to_account_info(),
                },
                signer,
            ),
            amount,
        )
    }

    /// Burn `amount` of an outcome token from the user (user signs).
    pub fn burn_outcome(&self, yes: bool, amount: u64) -> Result<()> {
        if amount == 0 {
            return Ok(());
        }
        let (mint, from) = if yes {
            (&self.yes_mint, &self.user_yes)
        } else {
            (&self.no_mint, &self.user_no)
        };
        token::burn(
            CpiContext::new(
                self.token_program.key(),
                Burn {
                    mint: mint.to_account_info(),
                    from: from.to_account_info(),
                    authority: self.user.to_account_info(),
                },
            ),
            amount,
        )
    }

    fn mint_outcome(&self, yes: bool, amount: u64) -> Result<()> {
        let (mint, to) = if yes {
            (&self.yes_mint, &self.user_yes)
        } else {
            (&self.no_mint, &self.user_no)
        };
        let seeds = self.market_seeds();
        let seed_refs: [&[u8]; 3] = [&seeds[0], &seeds[1], &seeds[2]];
        let signer: &[&[&[u8]]] = &[&seed_refs];
        token::mint_to(
            CpiContext::new_with_signer(
                self.token_program.key(),
                MintTo {
                    mint: mint.to_account_info(),
                    to: to.to_account_info(),
                    authority: self.market.to_account_info(),
                },
                signer,
            ),
            amount,
        )
    }
}

/// Deposit `amount` mUSDC, receive `amount` YES + `amount` NO.
pub fn handle_mint_complete_set(ctx: Context<CompleteSet>, amount: u64) -> Result<()> {
    require!(amount > 0, MarketError::InvalidAmount);
    let a = &ctx.accounts;
    require!(!a.market.is_resolved(), MarketError::AlreadyResolved);

    token::transfer(
        CpiContext::new(
            a.token_program.key(),
            Transfer {
                from: a.user_collateral.to_account_info(),
                to: a.vault.to_account_info(),
                authority: a.user.to_account_info(),
            },
        ),
        amount,
    )?;
    a.mint_outcome(true, amount)?;
    a.mint_outcome(false, amount)?;

    emit!(SetMinted {
        market: a.market.key(),
        user: a.user.key(),
        amount,
    });
    Ok(())
}

/// Return `amount` YES + `amount` NO, receive `amount` mUSDC. Allowed at any time.
pub fn handle_merge_complete_set(ctx: Context<CompleteSet>, amount: u64) -> Result<()> {
    require!(amount > 0, MarketError::InvalidAmount);
    let a = &ctx.accounts;
    a.burn_outcome(true, amount)?;
    a.burn_outcome(false, amount)?;
    a.pay_out(amount)?;

    emit!(SetMerged {
        market: a.market.key(),
        user: a.user.key(),
        amount,
    });
    Ok(())
}
