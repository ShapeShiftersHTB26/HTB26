use anchor_lang::prelude::*;

use crate::{error::MarketError, events::Redeemed, instructions::CompleteSet, state::Outcome};

/// Burn `yes_amount` YES and `no_amount` NO and pay according to the outcome:
/// Yes → 1 per YES, No → 1 per NO, Void → 0.5 per token of either side.
pub fn handle_redeem(ctx: Context<CompleteSet>, yes_amount: u64, no_amount: u64) -> Result<()> {
    let a = &ctx.accounts;
    require!(yes_amount > 0 || no_amount > 0, MarketError::InvalidAmount);

    let payout = match a.market.outcome {
        Outcome::Yes => yes_amount,
        Outcome::No => no_amount,
        Outcome::Void => {
            yes_amount
                .checked_add(no_amount)
                .ok_or(MarketError::MathOverflow)?
                / 2
        }
        Outcome::Unresolved => return err!(MarketError::NotResolved),
    };

    a.burn_outcome(true, yes_amount)?;
    a.burn_outcome(false, no_amount)?;
    a.pay_out(payout)?;

    emit!(Redeemed {
        market: a.market.key(),
        user: a.user.key(),
        yes_amount,
        no_amount,
        payout,
    });
    Ok(())
}
