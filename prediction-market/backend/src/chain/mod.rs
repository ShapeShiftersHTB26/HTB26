//! Thin Solana helpers shared by the API and the bots.

pub mod openbook;
pub mod program;

use anchor_lang::{
    prelude::{AccountMeta, Pubkey},
    solana_program::{instruction::Instruction, program_pack::Pack},
};
use anchor_spl::{
    associated_token::{get_associated_token_address, spl_associated_token_account},
    token::spl_token,
};
use anyhow::{anyhow, Context, Result};
use solana_commitment_config::CommitmentConfig;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_rpc_client::nonblocking::rpc_client::RpcClient;
use solana_signer::Signer;
use solana_transaction::Transaction;
use std::{path::Path, sync::Arc};

use crate::config::Config;

pub struct Chain {
    pub rpc: RpcClient,
    pub admin: Keypair,
    pub musdc: Pubkey,
    pub program_id: Pubkey,
    pub openbook_id: Pubkey,
}

pub type SharedChain = Arc<Chain>;

impl Chain {
    pub fn new(cfg: &Config) -> Result<Self> {
        Ok(Self {
            rpc: RpcClient::new_with_commitment(cfg.rpc_url.clone(), CommitmentConfig::confirmed()),
            admin: read_keypair(&cfg.admin_keypair)?,
            musdc: cfg.musdc_mint,
            program_id: cfg.program_id,
            openbook_id: cfg.openbook_program_id,
        })
    }

    pub fn admin_pk(&self) -> Pubkey {
        self.admin.pubkey()
    }

    /// Seconds the cluster clock is behind wall time. A restarted local validator resumes from its ledger's last
    /// block time, so it can lag by hours; on devnet it's ~0. 0 when it can't be read.
    pub async fn clock_lag_secs(&self) -> i64 {
        let Ok(slot) = self.rpc.get_slot().await else { return 0 };
        for s in [slot, slot.saturating_sub(1), slot.saturating_sub(5)] {
            if let Ok(t) = self.rpc.get_block_time(s).await {
                return chrono::Utc::now().timestamp() - t;
            }
        }
        0
    }

    /// Sign + send + confirm. `payer` pays fees; `extra` are additional signers.
    pub async fn send(&self, ixs: &[Instruction], payer: &Keypair, extra: &[&Keypair]) -> Result<String> {
        let mut all = Vec::with_capacity(ixs.len() + 1);
        all.push(ComputeBudgetInstruction::set_compute_unit_limit(1_400_000)); // max: a 20-order ladder is heavy
        all.extend_from_slice(ixs);

        let blockhash = self.rpc.get_latest_blockhash().await.context("get_latest_blockhash")?;
        let msg = Message::new(&all, Some(&payer.pubkey()));
        let mut signers: Vec<&Keypair> = vec![payer];
        for s in extra {
            if s.pubkey() != payer.pubkey() {
                signers.push(s);
            }
        }
        let mut tx = Transaction::new_unsigned(msg);
        tx.try_sign(&signers, blockhash).map_err(|e| anyhow!("signing failed: {e}"))?;
        let sig = self
            .rpc
            .send_and_confirm_transaction(&tx)
            .await
            .map_err(|e| anyhow!("{}", describe_rpc_error(&e)))?;
        Ok(sig.to_string())
    }

    pub async fn send_admin(&self, ixs: &[Instruction], extra: &[&Keypair]) -> Result<String> {
        self.send(ixs, &self.admin, extra).await
    }

    /// SPL token balance in base units; 0 if the account doesn't exist.
    pub async fn token_balance(&self, account: &Pubkey) -> u64 {
        match self.rpc.get_account_with_commitment(account, CommitmentConfig::confirmed()).await {
            Ok(resp) => resp
                .value
                .and_then(|a| spl_token::state::Account::unpack(&a.data).ok())
                .map(|a| a.amount)
                .unwrap_or(0),
            Err(_) => 0,
        }
    }

    pub async fn ata_balance(&self, owner: &Pubkey, mint: &Pubkey) -> u64 {
        self.token_balance(&ata(owner, mint)).await
    }

    pub async fn account_exists(&self, pk: &Pubkey) -> Result<bool> {
        Ok(self
            .rpc
            .get_account_with_commitment(pk, CommitmentConfig::confirmed())
            .await?
            .value
            .is_some())
    }

    pub async fn sol_balance(&self, pk: &Pubkey) -> u64 {
        self.rpc.get_balance(pk).await.unwrap_or(0)
    }

    /// Admin is the mUSDC mint authority.
    pub fn mint_musdc_ix(&self, to_owner: &Pubkey, amount: u64) -> Instruction {
        spl_token::instruction::mint_to(
            &spl_token::ID,
            &self.musdc,
            &ata(to_owner, &self.musdc),
            &self.admin_pk(),
            &[],
            amount,
        )
        .expect("mint_to ix")
    }
}

pub fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    get_associated_token_address(owner, mint)
}

pub fn create_ata_ix(payer: &Pubkey, owner: &Pubkey, mint: &Pubkey) -> Instruction {
    spl_associated_token_account::instruction::create_associated_token_account_idempotent(
        payer,
        owner,
        mint,
        &spl_token::ID,
    )
}

pub fn transfer_sol_ix(from: &Pubkey, to: &Pubkey, lamports: u64) -> Instruction {
    solana_system_interface::instruction::transfer(from, to, lamports)
}

pub fn read_keypair(path: &Path) -> Result<Keypair> {
    let raw = std::fs::read_to_string(path).with_context(|| format!("reading keypair {}", path.display()))?;
    let bytes: Vec<u8> = serde_json::from_str(&raw).context("keypair file must be a JSON byte array")?;
    Keypair::try_from(bytes.as_slice()).map_err(|e| anyhow!("invalid keypair {}: {e}", path.display()))
}

pub fn write_keypair(path: &Path, kp: &Keypair) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, serde_json::to_string(&kp.to_bytes().to_vec())?)?;
    Ok(())
}

/// Pull program logs out of a failed simulation so errors are readable.
fn describe_rpc_error(e: &solana_rpc_client_api::client_error::Error) -> String {
    use solana_rpc_client_api::{client_error::ErrorKind, request::RpcError, request::RpcResponseErrorData};
    if let ErrorKind::RpcError(RpcError::RpcResponseError { message, data, .. }) = e.kind() {
        if let RpcResponseErrorData::SendTransactionPreflightFailure(sim) = data {
            let logs = sim.logs.clone().unwrap_or_default();
            let tail: Vec<_> = logs.iter().rev().take(6).rev().cloned().collect();
            return format!("{message} | {}", tail.join(" | "));
        }
        return message.clone();
    }
    e.to_string()
}

pub fn readonly(pk: Pubkey) -> AccountMeta {
    AccountMeta::new_readonly(pk, false)
}

pub fn writable(pk: Pubkey) -> AccountMeta {
    AccountMeta::new(pk, false)
}
