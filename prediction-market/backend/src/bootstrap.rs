//! `pm-backend bootstrap`: idempotent chain setup for a fresh local validator (used by Docker).
//! Waits for the RPC, airdrops SOL to the admin (local validators only), creates the mUSDC mint
//! from MUSDC_MINT_KEYPAIR if it doesn't exist, and initializes the program Config.

use anchor_lang::solana_program::program_pack::Pack;
use anchor_spl::token::spl_token;
use anyhow::{bail, Context, Result};
use solana_signer::Signer;
use std::time::Duration;

use crate::{
    chain::{program, read_keypair, Chain},
    config::Config,
    markets::{CreateMarketReq, Markets},
};

const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

pub async fn run(cfg: &Config) -> Result<()> {
    let chain = Chain::new(cfg)?;
    let admin = chain.admin_pk();

    // 1. Wait for the validator.
    let mut ready = false;
    for _ in 0..180 {
        if chain.rpc.get_latest_blockhash().await.is_ok() {
            ready = true;
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    if !ready {
        bail!("RPC {} not reachable", cfg.rpc_url);
    }

    // 2. Program must be loaded (Docker loads it at genesis; otherwise run scripts/setup.sh).
    if !chain.account_exists(&chain.program_id).await? {
        bail!("prediction_market program {} is not deployed on {}", chain.program_id, cfg.rpc_url);
    }

    // 3. Fund the admin (only works on validators with a faucet, i.e. local).
    if chain.sol_balance(&admin).await < 100 * LAMPORTS_PER_SOL {
        match chain.rpc.request_airdrop(&admin, 1_000 * LAMPORTS_PER_SOL).await {
            Ok(sig) => {
                for _ in 0..60 {
                    if chain.rpc.confirm_transaction(&sig).await.unwrap_or(false) {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
                println!("airdropped 1000 SOL to admin {admin}");
            }
            Err(e) => println!("airdrop failed ({e}); fund admin {admin} manually"),
        }
    }

    // 4. mUSDC mint (6 decimals, mint authority = admin).
    if chain.account_exists(&chain.musdc).await? {
        println!("mUSDC mint exists: {}", chain.musdc);
    } else {
        let mint_kp = read_keypair(&cfg.musdc_mint_keypair).context("MUSDC_MINT_KEYPAIR needed to create the mint")?;
        if mint_kp.pubkey() != chain.musdc {
            bail!("MUSDC_MINT_KEYPAIR does not match MUSDC_MINT");
        }
        let space = spl_token::state::Mint::LEN;
        let rent = chain.rpc.get_minimum_balance_for_rent_exemption(space).await?;
        let sig = chain
            .send_admin(
                &[
                    solana_system_interface::instruction::create_account(
                        &admin,
                        &chain.musdc,
                        rent,
                        space as u64,
                        &spl_token::ID,
                    ),
                    spl_token::instruction::initialize_mint2(&spl_token::ID, &chain.musdc, &admin, None, 6)?,
                ],
                &[&mint_kp],
            )
            .await
            .context("create mUSDC mint")?;
        println!("created mUSDC mint {} (tx {sig})", chain.musdc);
    }

    // 5. Program Config.
    let config_pda = program::config_pda(&chain.program_id);
    if chain.account_exists(&config_pda).await? {
        println!("config already initialized: {config_pda}");
    } else {
        let ix = program::initialize_config_ix(&chain.program_id, &admin, &chain.musdc);
        let sig = chain.send_admin(&[ix], &[]).await?;
        println!("config initialized: {config_pda} (tx {sig})");
    }
    Ok(())
}

/// DEMO_MARKETS=true: create sample markets when the database is empty.
pub async fn seed_demo_markets(chain: &Chain, db: &sqlx::PgPool, markets: &Markets) -> Result<()> {
    if !crate::db::list_markets(db, None).await?.is_empty() {
        return Ok(());
    }
    let now = chrono::Utc::now();
    let demos = [
        (
            "Will the HM Land Registry average UK house price for December 2026 be above November 2026?",
            "Demo market (resolves in 7 days). Resolution source: HM Land Registry Price Paid data.",
            now + chrono::Duration::days(7),
            55,
        ),
        (
            "Quick demo: will this market resolve YES?",
            "Trading closes 15 minutes after startup so you can try resolve + redeem (POST /markets/:id/resolve).",
            now + chrono::Duration::minutes(15),
            50,
        ),
    ];
    for (question, description, resolution_time, price) in demos {
        let req = CreateMarketReq {
            question: question.into(),
            description: Some(description.into()),
            resolution_time,
            initial_price_cents: price,
            seed_sets: 1000,
            levels: 5,
            level_size: 50,
        };
        let c = markets.create(chain, db, &req).await?;
        tracing::info!(id = c.id, question, "demo market created");
    }
    Ok(())
}
