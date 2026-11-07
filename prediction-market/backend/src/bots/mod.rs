//! Background bot loop: crank → market maker → one random taker trade, every BOT_INTERVAL_MS.

mod crank;
mod mm;
mod takers;

use anchor_lang::prelude::Pubkey;
use anyhow::Result;
use chrono::Utc;
use rand::Rng;
use rand_distr::{Distribution, Normal};
use serde::Serialize;
use solana_keypair::Keypair;
use solana_signer::Signer;
use sqlx::PgPool;
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

use crate::{
    chain::{openbook::Book, program::MarketAddrs, read_keypair, write_keypair, SharedChain},
    config::Config,
    db,
};

/// Everything the bots need about one tradable market.
#[derive(Clone)]
pub struct ActiveMarket {
    pub id: i64,
    pub addrs: MarketAddrs,
    pub yes: Book,
    pub no: Book,
    pub yes_oo: Pubkey,
    pub no_oo: Pubkey,
    pub initial_price_cents: i64,
    pub levels: i64,
    pub level_size: i64,
}

#[derive(Default)]
struct BotState {
    /// Fair YES price in cents per market (bounded random walk).
    fair: HashMap<i64, f64>,
    last_mm: HashMap<i64, Instant>,
    /// (bot index, market id) pairs that already have ATAs + starting inventory.
    stocked: HashSet<(usize, i64)>,
    last_funding: Option<Instant>,
}

pub struct BotManager {
    pub running: AtomicBool,
    pub bots: Vec<Keypair>,
    interval: Duration,
    state: Mutex<BotState>,
    /// Copy of the fair prices for /bots/status (so status never waits on a running tick).
    fair_snapshot: std::sync::Mutex<HashMap<i64, f64>>,
}

#[derive(Serialize)]
pub struct BotStatus {
    pub running: bool,
    pub interval_ms: u64,
    pub bots: Vec<BotInfo>,
    pub fair_prices: HashMap<i64, f64>,
    pub trades_last_minute: i64,
}

#[derive(Serialize)]
pub struct BotInfo {
    pub pubkey: String,
    pub sol: f64,
    pub musdc: f64,
}

pub const MM_INTERVAL: Duration = Duration::from_secs(10);
const FUNDING_INTERVAL: Duration = Duration::from_secs(60);

impl BotManager {
    /// Load (or create) BOT_COUNT keypairs from BOT_KEYS_DIR.
    pub fn new(cfg: &Config) -> Result<Self> {
        let mut bots = Vec::with_capacity(cfg.bot_count);
        for i in 0..cfg.bot_count {
            let path = cfg.bot_keys_dir.join(format!("bot-{i}.json"));
            let kp = if path.exists() {
                read_keypair(&path)?
            } else {
                let kp = Keypair::new();
                write_keypair(&path, &kp)?;
                kp
            };
            bots.push(kp);
        }
        Ok(Self {
            running: AtomicBool::new(cfg.bots_autostart),
            bots,
            interval: Duration::from_millis(cfg.bot_interval_ms),
            state: Mutex::new(BotState::default()),
            fair_snapshot: Default::default(),
        })
    }

    pub fn set_running(&self, on: bool) {
        self.running.store(on, Ordering::SeqCst);
    }

    pub fn spawn(self: Arc<Self>, chain: SharedChain, db: PgPool) {
        tokio::spawn(async move {
            tracing::info!(bots = self.bots.len(), "bot loop started");
            loop {
                tokio::time::sleep(self.interval).await;
                if !self.running.load(Ordering::SeqCst) {
                    continue;
                }
                if let Err(e) = self.tick(&chain, &db).await {
                    tracing::warn!(error = %format!("{e:#}"), "bot tick failed");
                }
            }
        });
    }

    async fn tick(&self, chain: &SharedChain, db: &PgPool) -> Result<()> {
        let markets = load_active_markets(chain, db).await?;
        let mut st = self.state.lock().await;

        // Keep bot wallets topped up with SOL and mUSDC.
        if st.last_funding.map_or(true, |t| t.elapsed() > FUNDING_INTERVAL) {
            takers::fund_bots(chain, &self.bots).await;
            st.last_funding = Some(Instant::now());
        }
        if markets.is_empty() {
            return Ok(());
        }

        // Random-walk the fair prices and pick this tick's taker (ThreadRng is !Send: keep it scoped).
        let (taker_market, taker_bot) = {
            let mut rng = rand::thread_rng();
            let step = Normal::new(0.0, 1.0).unwrap();
            for m in &markets {
                let f = st.fair.entry(m.id).or_insert(m.initial_price_cents as f64);
                *f = (*f + step.sample(&mut rng)).clamp(5.0, 95.0);
            }
            (rng.gen_range(0..markets.len()), rng.gen_range(0..self.bots.len().max(1)))
        };
        *self.fair_snapshot.lock().unwrap() = st.fair.clone();

        // 1. Crank both books of every market (makes MM fills settle-able).
        for m in &markets {
            crank::crank_market(chain, m).await;
        }

        // 2. Market maker re-quotes every MM_INTERVAL per market.
        for m in &markets {
            let due = st.last_mm.get(&m.id).map_or(true, |t| t.elapsed() >= MM_INTERVAL);
            if due {
                let fair = st.fair[&m.id];
                if let Err(e) = mm::requote(chain, m, fair).await {
                    tracing::warn!(market = m.id, error = %format!("{e:#}"), "market maker failed");
                }
                st.last_mm.insert(m.id, Instant::now());
            }
        }

        // 3. One random taker trade.
        if !self.bots.is_empty() {
            let m = &markets[taker_market];
            let bot_idx = taker_bot;
            let fair = st.fair[&m.id];
            let stocked = st.stocked.contains(&(bot_idx, m.id));
            match takers::act(chain, db, m, &self.bots[bot_idx], fair, stocked).await {
                Ok(now_stocked) => {
                    if now_stocked {
                        st.stocked.insert((bot_idx, m.id));
                    }
                }
                Err(e) => tracing::warn!(market = m.id, error = %format!("{e:#}"), "taker failed"),
            }
        }
        Ok(())
    }

    pub async fn status(&self, chain: &SharedChain, db: &PgPool) -> Result<BotStatus> {
        let mut bots = Vec::new();
        for b in &self.bots {
            let pk = b.pubkey();
            bots.push(BotInfo {
                pubkey: pk.to_string(),
                sol: chain.sol_balance(&pk).await as f64 / 1e9,
                musdc: chain.ata_balance(&pk, &chain.musdc).await as f64 / 1e6,
            });
        }
        let fair_prices = self.fair_snapshot.lock().unwrap().clone();
        Ok(BotStatus {
            running: self.running.load(Ordering::SeqCst),
            interval_ms: self.interval.as_millis() as u64,
            bots,
            fair_prices,
            trades_last_minute: db::bot_trades_last_minute(db).await?,
        })
    }
}

/// Active markets whose books are still open (resolution time not reached).
async fn load_active_markets(chain: &SharedChain, db: &PgPool) -> Result<Vec<ActiveMarket>> {
    let now = Utc::now();
    let mut out = Vec::new();
    for m in db::list_markets(db, Some("active")).await? {
        if m.market.resolution_time <= now {
            continue;
        }
        let (Some(yb), Some(nb)) = (&m.yes_book, &m.no_book) else { continue };
        let addrs = m.market.addrs()?;
        out.push(ActiveMarket {
            id: m.market.id,
            addrs,
            yes: yb.book(chain.openbook_id, addrs.yes_mint, chain.musdc)?,
            no: nb.book(chain.openbook_id, addrs.no_mint, chain.musdc)?,
            yes_oo: yb.admin_open_orders()?,
            no_oo: nb.admin_open_orders()?,
            initial_price_cents: m.market.initial_price_cents as i64,
            levels: m.market.levels as i64,
            level_size: m.market.level_size,
        });
    }
    Ok(out)
}

pub fn clamp_cents(c: i64) -> i64 {
    c.clamp(1, 99)
}
