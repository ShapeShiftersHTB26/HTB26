use anyhow::{Context, Result};
use anchor_lang::prelude::Pubkey;
use solana_keypair::Keypair;
use solana_signer::Signer;
use std::{path::PathBuf, str::FromStr};

use crate::chain::{read_keypair, write_keypair};

#[derive(Clone, Debug)]
pub struct Config {
    pub rpc_url: String,
    /// RPC URL handed to browsers via /config (differs from RPC_URL inside Docker).
    pub public_rpc_url: String,
    pub database_url: String,
    pub admin_keypair: PathBuf,
    pub musdc_mint: Pubkey,
    /// Keypair of the mUSDC mint account; only needed by `bootstrap` to create the mint.
    pub musdc_mint_keypair: PathBuf,
    pub program_id: Pubkey,
    pub openbook_program_id: Pubkey,
    pub admin_api_key: String,
    pub bind_addr: String,
    pub bot_count: usize,
    pub bot_interval_ms: u64,
    pub bots_autostart: bool,
    pub bot_keys_dir: PathBuf,
    /// Lamports sent with each faucet claim (0 disables the SOL drip).
    pub faucet_sol_lamports: u64,
    /// Create a couple of demo markets on startup when the database has none.
    pub demo_markets: bool,
}

fn var(name: &str) -> Result<String> {
    std::env::var(name).with_context(|| format!("missing env var {name}"))
}

fn var_or(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
}

/// With AUTO_CREATE_KEYS=true (Docker), missing keypair files are generated on first start.
fn ensure_keypair(path: &PathBuf, auto_create: bool) -> Result<()> {
    if auto_create && !path.exists() {
        write_keypair(path, &Keypair::new())?;
        tracing::info!(path = %path.display(), "generated keypair");
    }
    Ok(())
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let auto_create: bool = var_or("AUTO_CREATE_KEYS", "false").parse()?;
        let admin_keypair: PathBuf = var_or("ADMIN_KEYPAIR", "../keys/admin.json").into();
        ensure_keypair(&admin_keypair, auto_create)?;

        // mUSDC mint: explicit MUSDC_MINT, or the pubkey of MUSDC_MINT_KEYPAIR.
        let musdc_mint_keypair: PathBuf = var_or("MUSDC_MINT_KEYPAIR", "../keys/musdc-mint.json").into();
        let musdc_mint = match std::env::var("MUSDC_MINT") {
            Ok(s) if !s.is_empty() => Pubkey::from_str(&s).context("MUSDC_MINT")?,
            _ => {
                ensure_keypair(&musdc_mint_keypair, auto_create)?;
                read_keypair(&musdc_mint_keypair)
                    .context("set MUSDC_MINT or provide MUSDC_MINT_KEYPAIR")?
                    .pubkey()
            }
        };

        let rpc_url = var_or("RPC_URL", "http://127.0.0.1:8899");
        Ok(Self {
            public_rpc_url: var_or("PUBLIC_RPC_URL", &rpc_url),
            rpc_url,
            database_url: var("DATABASE_URL")?,
            admin_keypair,
            musdc_mint,
            musdc_mint_keypair,
            program_id: Pubkey::from_str(&var_or("PROGRAM_ID", &prediction_market::ID.to_string()))
                .context("PROGRAM_ID")?,
            openbook_program_id: Pubkey::from_str(&var_or(
                "OPENBOOK_PROGRAM_ID",
                "opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb",
            ))
            .context("OPENBOOK_PROGRAM_ID")?,
            admin_api_key: var("ADMIN_API_KEY")?,
            bind_addr: var_or("BIND_ADDR", "0.0.0.0:8080"),
            bot_count: var_or("BOT_COUNT", "5").parse()?,
            bot_interval_ms: var_or("BOT_INTERVAL_MS", "3000").parse()?,
            bots_autostart: var_or("BOTS_AUTOSTART", "true").parse()?,
            bot_keys_dir: var_or("BOT_KEYS_DIR", "../keys/bots").into(),
            faucet_sol_lamports: var_or("FAUCET_SOL_LAMPORTS", "50000000").parse()?,
            demo_markets: var_or("DEMO_MARKETS", "false").parse()?,
        })
    }
}
