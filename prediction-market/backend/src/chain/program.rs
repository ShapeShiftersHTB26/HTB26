//! Instruction builders for our `prediction_market` program (typed via the program crate).

use anchor_lang::{
    prelude::Pubkey,
    solana_program::{instruction::Instruction, system_program},
    InstructionData, ToAccountMetas,
};
use anchor_spl::token::spl_token;
use prediction_market::{accounts, constants::*, instruction, state::Outcome};

use super::ata;

#[derive(Clone, Copy, Debug)]
pub struct MarketAddrs {
    pub id: u64,
    pub market: Pubkey,
    pub yes_mint: Pubkey,
    pub no_mint: Pubkey,
    pub vault: Pubkey,
}

pub fn config_pda(program_id: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[CONFIG_SEED], program_id).0
}

pub fn market_addrs(program_id: &Pubkey, id: u64) -> MarketAddrs {
    let market = Pubkey::find_program_address(&[MARKET_SEED, &id.to_le_bytes()], program_id).0;
    MarketAddrs {
        id,
        market,
        yes_mint: Pubkey::find_program_address(&[YES_MINT_SEED, market.as_ref()], program_id).0,
        no_mint: Pubkey::find_program_address(&[NO_MINT_SEED, market.as_ref()], program_id).0,
        vault: Pubkey::find_program_address(&[VAULT_SEED, market.as_ref()], program_id).0,
    }
}

pub fn initialize_config_ix(program_id: &Pubkey, admin: &Pubkey, collateral_mint: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        *program_id,
        &instruction::InitializeConfig {}.data(),
        accounts::InitializeConfig {
            admin: *admin,
            config: config_pda(program_id),
            collateral_mint: *collateral_mint,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

pub fn initialize_market_ix(
    program_id: &Pubkey,
    admin: &Pubkey,
    collateral_mint: &Pubkey,
    m: &MarketAddrs,
    resolution_time: i64,
) -> Instruction {
    Instruction::new_with_bytes(
        *program_id,
        &instruction::InitializeMarket { id: m.id, resolution_time }.data(),
        accounts::InitializeMarket {
            admin: *admin,
            config: config_pda(program_id),
            collateral_mint: *collateral_mint,
            market: m.market,
            yes_mint: m.yes_mint,
            no_mint: m.no_mint,
            vault: m.vault,
            token_program: spl_token::ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn set_metas(m: &MarketAddrs, collateral_mint: &Pubkey, user: &Pubkey) -> Vec<anchor_lang::prelude::AccountMeta> {
    accounts::CompleteSet {
        user: *user,
        market: m.market,
        yes_mint: m.yes_mint,
        no_mint: m.no_mint,
        vault: m.vault,
        user_collateral: ata(user, collateral_mint),
        user_yes: ata(user, &m.yes_mint),
        user_no: ata(user, &m.no_mint),
        token_program: spl_token::ID,
    }
    .to_account_metas(None)
}

pub fn mint_set_ix(program_id: &Pubkey, m: &MarketAddrs, collateral_mint: &Pubkey, user: &Pubkey, amount: u64) -> Instruction {
    Instruction::new_with_bytes(
        *program_id,
        &instruction::MintCompleteSet { amount }.data(),
        set_metas(m, collateral_mint, user),
    )
}

pub fn merge_set_ix(program_id: &Pubkey, m: &MarketAddrs, collateral_mint: &Pubkey, user: &Pubkey, amount: u64) -> Instruction {
    Instruction::new_with_bytes(
        *program_id,
        &instruction::MergeCompleteSet { amount }.data(),
        set_metas(m, collateral_mint, user),
    )
}

pub fn resolve_ix(program_id: &Pubkey, admin: &Pubkey, m: &MarketAddrs, outcome: Outcome) -> Instruction {
    Instruction::new_with_bytes(
        *program_id,
        &instruction::ResolveMarket { outcome }.data(),
        accounts::ResolveMarket {
            admin: *admin,
            config: config_pda(program_id),
            market: m.market,
        }
        .to_account_metas(None),
    )
}
