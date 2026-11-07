use anchor_lang::prelude::*;

/// Global singleton: who may create/resolve markets and which mint is collateral.
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    /// mUSDC — pinned so markets can't be created with fake collateral.
    pub collateral_mint: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    /// Equals `markets.id` in Postgres; part of the PDA seeds.
    pub id: u64,
    pub collateral_mint: Pubkey,
    pub yes_mint: Pubkey,
    pub no_mint: Pubkey,
    /// mUSDC token account owned by the Market PDA.
    pub vault: Pubkey,
    pub resolution_time: i64,
    pub outcome: Outcome,
    /// 0 while unresolved.
    pub resolved_at: i64,
    pub bump: u8,
}

impl Market {
    pub fn is_resolved(&self) -> bool {
        self.outcome != Outcome::Unresolved
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Outcome {
    Unresolved,
    Yes,
    No,
    Void,
}
