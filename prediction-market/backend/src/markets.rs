//! Market lifecycle: create (both books + seeded liquidity) and resolve.

use anchor_lang::prelude::Pubkey;
use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use prediction_market::state::Outcome;
use serde::Deserialize;
use solana_keypair::Keypair;
use solana_signer::Signer;
use sqlx::PgPool;
use tokio::sync::Mutex;

use crate::{
    chain::{
        create_ata_ix,
        openbook::{self, Book, Quote, BASE_LOTS_PER_TOKEN},
        program::{self, MarketAddrs},
        Chain,
    },
    db,
};

pub const TOKEN: u64 = 1_000_000; // 1 token / 1 mUSDC in base units (6 decimals)

#[derive(Debug, Deserialize)]
pub struct CreateMarketReq {
    pub question: String,
    pub description: Option<String>,
    pub resolution_time: DateTime<Utc>,
    #[serde(default = "d_price")]
    pub initial_price_cents: i64,
    /// Complete sets (whole tokens) minted by the admin to back the ask ladders.
    #[serde(default = "d_seed")]
    pub seed_sets: u64,
    #[serde(default = "d_levels")]
    pub levels: i64,
    /// Whole tokens per ladder level.
    #[serde(default = "d_level_size")]
    pub level_size: i64,
}
fn d_price() -> i64 { 50 }
fn d_seed() -> u64 { 1000 }
fn d_levels() -> i64 { 5 }
fn d_level_size() -> i64 { 50 }

impl CreateMarketReq {
    pub fn validate(&self) -> Result<()> {
        let q = self.question.trim();
        if q.len() < 10 || q.len() > 300 {
            bail!("question must be 10-300 characters");
        }
        if !(2..=98).contains(&self.initial_price_cents) {
            bail!("initial_price_cents must be 2..=98");
        }
        if !(1..=10).contains(&self.levels) || self.level_size < 1 {
            bail!("levels must be 1..=10 and level_size >= 1");
        }
        if (self.seed_sets as i64) < self.levels * self.level_size {
            bail!("seed_sets must be >= levels * level_size so the ask ladders are backed");
        }
        if self.resolution_time <= Utc::now() + chrono::Duration::seconds(30) {
            bail!("resolution_time must be at least 30s in the future");
        }
        Ok(())
    }
}

/// Symmetric ladder around `center` cents: bids center-1.., asks center+1.. (clamped to 1..=99).
pub fn ladder(center: i64, levels: i64, level_size_tokens: i64) -> (Vec<Quote>, Vec<Quote>) {
    let base_lots = level_size_tokens * BASE_LOTS_PER_TOKEN;
    let bids = (1..=levels)
        .map(|i| center - i)
        .filter(|p| *p >= 1)
        .map(|price_lots| Quote { price_lots, base_lots })
        .collect();
    let asks = (1..=levels)
        .map(|i| center + i)
        .filter(|p| *p <= 99)
        .map(|price_lots| Quote { price_lots, base_lots })
        .collect();
    (bids, asks)
}

/// mUSDC (base units) needed to back a set of bids.
pub fn bid_notional(bids: &[Quote]) -> u64 {
    // base_lots * 0.01 token * price/100 mUSDC  ==  base_lots * price_lots * 100 base units
    bids.iter().map(|q| (q.base_lots * q.price_lots * 100) as u64).sum()
}

pub struct Created {
    pub id: i64,
    /// false when an existing market with the same query was returned.
    pub created: bool,
}

/// sha256 (hex) of the question, normalized: trimmed, lowercased, whitespace collapsed.
/// Today it de-duplicates markets; later it becomes the market id.
pub fn query_hash(question: &str) -> String {
    use sha2::{Digest, Sha256};
    let normalized = question.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
    Sha256::digest(normalized.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

pub struct Markets {
    /// Market creation is serialized: open-orders account addresses depend on a per-owner counter.
    create_lock: Mutex<()>,
}

impl Markets {
    pub fn new() -> Self {
        Self { create_lock: Mutex::new(()) }
    }

    /// Create + seed a market. If a live market with the same query hash exists, returns it instead.
    pub async fn create(&self, chain: &Chain, db: &PgPool, req: &CreateMarketReq) -> Result<Created> {
        req.validate()?;
        let hash = query_hash(&req.question);
        let _guard = self.create_lock.lock().await;
        if let Some(id) = db::find_by_query_hash(db, &hash).await? {
            return Ok(Created { id, created: false });
        }
        let id = db::insert_pending_market(
            db,
            &db::NewMarket {
                question: req.question.trim(),
                query_hash: &hash,
                description: req.description.as_deref(),
                resolution_time: req.resolution_time,
                initial_price_cents: req.initial_price_cents as i32,
                seed_sets: (req.seed_sets * TOKEN) as i64,
                levels: req.levels as i32,
                level_size: req.level_size,
            },
        )
        .await?;

        let mut txs = Vec::new();
        match create_onchain(chain, db, req, id, &mut txs).await {
            Ok(()) => {
                tracing::info!(id, "market created");
                Ok(Created { id, created: true })
            }
            Err(e) => {
                let msg = format!("{e:#}");
                tracing::error!(id, error = %msg, "market creation failed");
                db::mark_failed(db, id, &msg, &txs).await?;
                Err(e)
            }
        }
    }
}

async fn create_onchain(chain: &Chain, db: &PgPool, req: &CreateMarketReq, id: i64, txs: &mut Vec<String>) -> Result<()> {
    let admin = chain.admin_pk();
    let addrs = program::market_addrs(&chain.program_id, id as u64);
    let resolution_ts = req.resolution_time.timestamp();

    // Tx A: our program — Market PDA, YES/NO mints, vault.
    txs.push(
        chain
            .send_admin(
                &[program::initialize_market_ix(&chain.program_id, &admin, &chain.musdc, &addrs, resolution_ts)],
                &[],
            )
            .await
            .context("initialize_market")?,
    );

    // Tx B1/B2: one OpenBook market per outcome, expiring at resolution time.
    let yes_book = create_book(chain, &addrs.yes_mint, &format!("PM-{id}-YES"), resolution_ts, txs)
        .await
        .context("create YES book")?;
    let no_book = create_book(chain, &addrs.no_mint, &format!("PM-{id}-NO"), resolution_ts, txs)
        .await
        .context("create NO book")?;

    // Tx C: fund the seed — mUSDC for sets + both bid ladders, then mint complete sets.
    let p = req.initial_price_cents;
    let (yes_bids, yes_asks) = ladder(p, req.levels, req.level_size);
    let (no_bids, no_asks) = ladder(100 - p, req.levels, req.level_size);
    let seed = req.seed_sets * TOKEN;
    let usdc_needed = seed + bid_notional(&yes_bids) + bid_notional(&no_bids);
    txs.push(
        chain
            .send_admin(
                &[
                    create_ata_ix(&admin, &admin, &chain.musdc),
                    create_ata_ix(&admin, &admin, &addrs.yes_mint),
                    create_ata_ix(&admin, &admin, &addrs.no_mint),
                    chain.mint_musdc_ix(&admin, usdc_needed),
                    program::mint_set_ix(&chain.program_id, &addrs, &chain.musdc, &admin, seed),
                ],
                &[],
            )
            .await
            .context("fund seed")?,
    );

    // Tx D: admin open-orders accounts on both books.
    let (yes_oo, no_oo) = create_admin_open_orders(chain, id, &yes_book, &no_book, txs).await?;

    // Tx E1/E2: seed both ladders.
    txs.push(
        chain
            .send_admin(&[openbook::place_orders_ix(&yes_book, &admin, &yes_oo, &yes_bids, &yes_asks, false)], &[])
            .await
            .context("seed YES ladder")?,
    );
    txs.push(
        chain
            .send_admin(&[openbook::place_orders_ix(&no_book, &admin, &no_oo, &no_bids, &no_asks, false)], &[])
            .await
            .context("seed NO ladder")?,
    );

    db::activate_market(db, &addrs, [("yes", &yes_book, &yes_oo), ("no", &no_book, &no_oo)], txs).await?;
    Ok(())
}

async fn create_book(chain: &Chain, base_mint: &Pubkey, name: &str, time_expiry: i64, txs: &mut Vec<String>) -> Result<Book> {
    let admin = chain.admin_pk();
    let market_kp = Keypair::new();
    let bids_kp = Keypair::new();
    let asks_kp = Keypair::new();
    let heap_kp = Keypair::new();
    let book = Book {
        program_id: chain.openbook_id,
        market: market_kp.pubkey(),
        bids: bids_kp.pubkey(),
        asks: asks_kp.pubkey(),
        event_heap: heap_kp.pubkey(),
        base_mint: *base_mint,
        quote_mint: chain.musdc,
    };

    let side_rent = chain.rpc.get_minimum_balance_for_rent_exemption(openbook::BOOKSIDE_SPACE as usize).await?;
    let heap_rent = chain.rpc.get_minimum_balance_for_rent_exemption(openbook::EVENT_HEAP_SPACE as usize).await?;
    let create = |kp: &Keypair, lamports: u64, space: u64| {
        solana_system_interface::instruction::create_account(&admin, &kp.pubkey(), lamports, space, &chain.openbook_id)
    };
    // Big zeroed accounts first (OpenBook `#[account(zero)]`), then create_market.
    txs.push(
        chain
            .send_admin(
                &[
                    create(&bids_kp, side_rent, openbook::BOOKSIDE_SPACE),
                    create(&asks_kp, side_rent, openbook::BOOKSIDE_SPACE),
                    create(&heap_kp, heap_rent, openbook::EVENT_HEAP_SPACE),
                ],
                &[&bids_kp, &asks_kp, &heap_kp],
            )
            .await
            .context("allocate book accounts")?,
    );
    txs.push(
        chain
            .send_admin(&[openbook::create_market_ix(&book, &admin, name, time_expiry, &admin)], &[&market_kp])
            .await
            .context("create_market")?,
    );
    Ok(book)
}

async fn create_admin_open_orders(
    chain: &Chain,
    id: i64,
    yes_book: &Book,
    no_book: &Book,
    txs: &mut Vec<String>,
) -> Result<(Pubkey, Pubkey)> {
    let admin = chain.admin_pk();
    let ob = chain.openbook_id;
    let indexer = openbook::open_orders_indexer(&ob, &admin);
    let mut ixs = vec![];
    let counter = match chain.rpc.get_account_with_commitment(&indexer, chain.rpc.commitment()).await?.value {
        Some(acc) => openbook::parse_indexer_counter(&acc.data).context("bad indexer account")?,
        None => {
            ixs.push(openbook::create_open_orders_indexer_ix(&ob, &admin, &admin));
            0
        }
    };
    let yes_oo = openbook::open_orders_account(&ob, &admin, counter + 1);
    let no_oo = openbook::open_orders_account(&ob, &admin, counter + 2);
    ixs.push(openbook::create_open_orders_account_ix(&ob, &admin, &admin, &yes_book.market, &yes_oo, &format!("pm-{id}-yes")));
    ixs.push(openbook::create_open_orders_account_ix(&ob, &admin, &admin, &no_book.market, &no_oo, &format!("pm-{id}-no")));
    txs.push(chain.send_admin(&ixs, &[]).await.context("create open orders accounts")?);
    Ok((yes_oo, no_oo))
}

pub fn parse_outcome(s: &str) -> Result<Outcome> {
    Ok(match s {
        "yes" => Outcome::Yes,
        "no" => Outcome::No,
        "void" => Outcome::Void,
        _ => bail!("outcome must be yes | no | void"),
    })
}

/// Resolve on-chain, pull the market maker's orders/funds, update the DB.
pub async fn resolve(chain: &Chain, db: &PgPool, id: i64, outcome_str: &str) -> Result<String> {
    let outcome = parse_outcome(outcome_str)?;
    let m = db::get_market(db, id).await?.context("market not found")?;
    if m.market.status != "active" {
        bail!("market is {}, not active", m.market.status);
    }
    if Utc::now() < m.market.resolution_time {
        bail!("resolution time {} not reached yet", m.market.resolution_time);
    }
    let addrs: MarketAddrs = m.market.addrs()?;
    let admin = chain.admin_pk();
    let sig = chain
        .send_admin(&[program::resolve_ix(&chain.program_id, &admin, &addrs, outcome)], &[])
        .await
        .context("resolve_market")?;
    db::mark_resolved(db, id, outcome_str).await?;

    // Best effort: cancel the MM's resting orders and settle both books.
    for (row, base) in [(&m.yes_book, addrs.yes_mint), (&m.no_book, addrs.no_mint)] {
        let Some(row) = row else { continue };
        let book = row.book(chain.openbook_id, base, chain.musdc)?;
        let oo = row.admin_open_orders()?;
        let ixs = [
            openbook::consume_events_ix(&book, 10, &[oo]),
            openbook::cancel_all_orders_ix(&book, &admin, &oo),
            openbook::settle_funds_ix(&book, &admin, &oo),
        ];
        if let Err(e) = chain.send_admin(&ixs, &[]).await {
            tracing::warn!(id, error = %e, "post-resolution cleanup failed");
        }
    }
    Ok(sig)
}
