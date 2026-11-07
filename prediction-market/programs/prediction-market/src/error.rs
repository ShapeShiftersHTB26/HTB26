use anchor_lang::prelude::*;

#[error_code]
pub enum MarketError {
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Resolution time must be in the future")]
    InvalidResolutionTime,
    #[msg("Market is already resolved")]
    AlreadyResolved,
    #[msg("Market is not resolved yet")]
    NotResolved,
    #[msg("Resolution time has not been reached")]
    TooEarly,
    #[msg("Outcome must be Yes, No or Void")]
    InvalidOutcome,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
