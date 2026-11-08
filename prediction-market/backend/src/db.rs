use anchor_lang::prelude::Pubkey;
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use sqlx::{postgres::PgPoolOptions, types::Json, FromRow, PgPool};
use std::str::FromStr;

use crate::chain::{openbook::Book, program::MarketAddrs};

pub async fn connect(url: &str) -> Result<PgPool> {
    let pool = PgPoolOptions::new().max_connections(10).connect(url).await.context("connecting to Postgres")?;
    sqlx::migrate!("./migrations").run(&pool).await.context("running migrations")?;
    Ok(pool)
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct MarketRow {
    pub id: i64,
    pub question: String,
    pub description: Option<String>,
    pub status: String,
    pub outcome: Option<String>,
    pub resolution_time: DateTime<Utc>,
    pub initial_price_cents: i32,
    pub seed_sets: i64,
    pub levels: i32,
    pub level_size: i64,
    pub market_pda: Option<String>,
    pub yes_mint: Option<String>,
    pub no_mint: Option<String>,
    pub vault: Option<String>,
    pub create_txs: Vec<String>,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub resolved_at: Option<DateTime<Utc>>,
    pub query_hash: Option<String>,
    /// Settlement rule for markets settled by data (Backtrace), with `settlement` evidence once resolved.
    pub resolution: Option<Json<Value>>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct OrderbookRow {
    pub market_id: i64,
    pub outcome: String,
    pub ob_market: String,
    pub bids: String,
    pub asks: String,
    pub event_heap: String,
    pub admin_open_orders: String,
}

/// A market joined with both of its order books (only for markets that finished creation).
#[derive(Debug, Clone, Serialize)]
pub struct MarketWithBooks {
    #[serde(flatten)]
    pub market: MarketRow,
    pub yes_book: Option<OrderbookRow>,
    pub no_book: Option<OrderbookRow>,
}

fn pk(s: &str) -> Result<Pubkey> {
    Pubkey::from_str(s).with_context(|| format!("bad pubkey in db: {s}"))
}

impl MarketRow {
    pub fn addrs(&self) -> Result<MarketAddrs> {
        Ok(MarketAddrs {
            id: self.id as u64,
            market: pk(self.market_pda.as_deref().context("market_pda missing")?)?,
            yes_mint: pk(self.yes_mint.as_deref().context("yes_mint missing")?)?,
            no_mint: pk(self.no_mint.as_deref().context("no_mint missing")?)?,
            vault: pk(self.vault.as_deref().context("vault missing")?)?,
        })
    }
}

impl OrderbookRow {
    pub fn book(&self, openbook_id: Pubkey, base_mint: Pubkey, quote_mint: Pubkey) -> Result<Book> {
        Ok(Book {
            program_id: openbook_id,
            market: pk(&self.ob_market)?,
            bids: pk(&self.bids)?,
            asks: pk(&self.asks)?,
            event_heap: pk(&self.event_heap)?,
            base_mint,
            quote_mint,
        })
    }
    pub fn admin_open_orders(&self) -> Result<Pubkey> {
        pk(&self.admin_open_orders)
    }
}

pub struct NewMarket<'a> {
    pub question: &'a str,
    pub query_hash: &'a str,
    pub description: Option<&'a str>,
    pub resolution_time: DateTime<Utc>,
    pub initial_price_cents: i32,
    pub seed_sets: i64,
    pub levels: i32,
    pub level_size: i64,
    pub resolution: Option<&'a Value>,
}

pub async fn insert_pending_market(db: &PgPool, m: &NewMarket<'_>) -> Result<i64> {
    let id: (i64,) = sqlx::query_as(
        "insert into markets (question, description, resolution_time, initial_price_cents, seed_sets, levels, level_size, query_hash, resolution)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id",
    )
    .bind(m.question)
    .bind(m.description)
    .bind(m.resolution_time)
    .bind(m.initial_price_cents)
    .bind(m.seed_sets)
    .bind(m.levels)
    .bind(m.level_size)
    .bind(m.query_hash)
    .bind(m.resolution.map(Json))
    .fetch_one(db)
    .await?;
    Ok(id.0)
}

/// Live (non-failed) market for a query hash, if any.
pub async fn find_by_query_hash(db: &PgPool, hash: &str) -> Result<Option<i64>> {
    let row: Option<(i64,)> =
        sqlx::query_as("select id from markets where query_hash = $1 and status <> 'failed' order by id limit 1")
            .bind(hash)
            .fetch_optional(db)
            .await?;
    Ok(row.map(|r| r.0))
}

pub async fn mark_failed(db: &PgPool, id: i64, error: &str, txs: &[String]) -> Result<()> {
    sqlx::query("update markets set status = 'failed', error = $2, create_txs = $3 where id = $1")
        .bind(id)
        .bind(error)
        .bind(txs)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn activate_market(
    db: &PgPool,
    addrs: &MarketAddrs,
    books: [(&str, &Book, &Pubkey); 2],
    txs: &[String],
) -> Result<()> {
    let mut tx = db.begin().await?;
    for (outcome, book, oo) in books {
        sqlx::query(
            "insert into orderbooks (market_id, outcome, ob_market, bids, asks, event_heap, admin_open_orders)
             values ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(addrs.id as i64)
        .bind(outcome)
        .bind(book.market.to_string())
        .bind(book.bids.to_string())
        .bind(book.asks.to_string())
        .bind(book.event_heap.to_string())
        .bind(oo.to_string())
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query(
        "update markets set status = 'active', market_pda = $2, yes_mint = $3, no_mint = $4, vault = $5, create_txs = $6
         where id = $1",
    )
    .bind(addrs.id as i64)
    .bind(addrs.market.to_string())
    .bind(addrs.yes_mint.to_string())
    .bind(addrs.no_mint.to_string())
    .bind(addrs.vault.to_string())
    .bind(txs)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

/// `evidence` (data-settled markets) is kept as `resolution.settlement`.
pub async fn mark_resolved(db: &PgPool, id: i64, outcome: &str, evidence: Option<&Value>) -> Result<()> {
    sqlx::query(
        "update markets set status = 'resolved', outcome = $2, resolved_at = now(),
           resolution = case when $3::jsonb is null then resolution
                             else coalesce(resolution, '{}'::jsonb) || jsonb_build_object('settlement', $3::jsonb) end
         where id = $1",
    )
        .bind(id)
        .bind(outcome)
        .bind(evidence.map(Json))
        .execute(db)
        .await?;
    Ok(())
}

pub async fn get_market(db: &PgPool, id: i64) -> Result<Option<MarketWithBooks>> {
    let Some(market) = sqlx::query_as::<_, MarketRow>("select * from markets where id = $1")
        .bind(id)
        .fetch_optional(db)
        .await?
    else {
        return Ok(None);
    };
    let books = sqlx::query_as::<_, OrderbookRow>("select * from orderbooks where market_id = $1")
        .bind(id)
        .fetch_all(db)
        .await?;
    Ok(Some(join(market, books)))
}

/// All markets (newest first) with their books. `status` filters if given.
pub async fn list_markets(db: &PgPool, status: Option<&str>) -> Result<Vec<MarketWithBooks>> {
    let markets = sqlx::query_as::<_, MarketRow>(
        "select * from markets where ($1::text is null or status = $1) order by id desc",
    )
    .bind(status)
    .fetch_all(db)
    .await?;
    let books = sqlx::query_as::<_, OrderbookRow>("select * from orderbooks").fetch_all(db).await?;
    Ok(markets
        .into_iter()
        .map(|m| {
            let mine = books.iter().filter(|b| b.market_id == m.id).cloned().collect();
            join(m, mine)
        })
        .collect())
}

fn join(market: MarketRow, books: Vec<OrderbookRow>) -> MarketWithBooks {
    let mut yes_book = None;
    let mut no_book = None;
    for b in books {
        if b.outcome == "yes" {
            yes_book = Some(b);
        } else {
            no_book = Some(b);
        }
    }
    MarketWithBooks { market, yes_book, no_book }
}

pub struct BotTrade<'a> {
    pub market_id: i64,
    pub book: &'a str,
    pub bot: String,
    pub side: &'a str,
    pub size_lots: i64,
    pub limit_cents: i32,
    pub tx: String,
}

pub async fn insert_bot_trade(db: &PgPool, t: &BotTrade<'_>) -> Result<()> {
    sqlx::query(
        "insert into bot_trades (market_id, book, bot, side, size_lots, limit_cents, tx) values ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(t.market_id)
    .bind(t.book)
    .bind(&t.bot)
    .bind(t.side)
    .bind(t.size_lots)
    .bind(t.limit_cents)
    .bind(&t.tx)
    .execute(db)
    .await?;
    Ok(())
}

#[derive(Debug, Serialize, FromRow)]
pub struct BotTradeRow {
    pub id: i64,
    pub market_id: i64,
    pub book: String,
    pub bot: String,
    pub side: String,
    pub size_lots: i64,
    pub limit_cents: i32,
    pub tx: String,
    pub created_at: DateTime<Utc>,
}

pub async fn recent_bot_trades(db: &PgPool, market_id: i64, limit: i64) -> Result<Vec<BotTradeRow>> {
    Ok(sqlx::query_as::<_, BotTradeRow>(
        "select * from bot_trades where market_id = $1 order by created_at desc limit $2",
    )
    .bind(market_id)
    .bind(limit)
    .fetch_all(db)
    .await?)
}

pub async fn bot_trades_last_minute(db: &PgPool) -> Result<i64> {
    let n: (i64,) = sqlx::query_as("select count(*) from bot_trades where created_at > now() - interval '1 minute'")
        .fetch_one(db)
        .await?;
    Ok(n.0)
}

/// Returns true if the wallet may claim (and records the claim), false if rate-limited (1/hour).
pub async fn try_faucet_claim(db: &PgPool, wallet: &str) -> Result<bool> {
    let res = sqlx::query(
        "insert into faucet_claims (wallet, last_claim) values ($1, now())
         on conflict (wallet) do update set last_claim = now()
         where faucet_claims.last_claim < now() - interval '1 hour'",
    )
    .bind(wallet)
    .execute(db)
    .await?;
    Ok(res.rows_affected() == 1)
}

pub async fn undo_faucet_claim(db: &PgPool, wallet: &str) -> Result<()> {
    sqlx::query("delete from faucet_claims where wallet = $1").bind(wallet).execute(db).await?;
    Ok(())
}
