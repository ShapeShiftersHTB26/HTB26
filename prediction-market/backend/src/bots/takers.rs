//! Random trader bots: IOC take orders on the YES and NO books around the fair price.

use anyhow::{Context, Result};
use rand::Rng;
use solana_keypair::Keypair;
use solana_signer::Signer;
use sqlx::PgPool;

use super::{clamp_cents, ActiveMarket};
use crate::{
    chain::{create_ata_ix, openbook, program, transfer_sol_ix, Chain},
    db,
    markets::TOKEN,
};

const MIN_SOL: u64 = 50_000_000; // 0.05 SOL
const TOP_UP_SOL: u64 = 100_000_000; // 0.1 SOL
const MIN_USDC: u64 = 1_000 * TOKEN;
const TOP_UP_USDC: u64 = 10_000 * TOKEN;
const STARTING_SETS: u64 = 500 * TOKEN;

/// Admin tops up every bot that is low on SOL or mUSDC.
pub async fn fund_bots(chain: &Chain, bots: &[Keypair]) {
    let admin = chain.admin_pk();
    for bot in bots {
        let pk = bot.pubkey();
        let mut ixs = vec![];
        if chain.sol_balance(&pk).await < MIN_SOL {
            ixs.push(transfer_sol_ix(&admin, &pk, TOP_UP_SOL));
        }
        if chain.ata_balance(&pk, &chain.musdc).await < MIN_USDC {
            ixs.push(create_ata_ix(&admin, &pk, &chain.musdc));
            ixs.push(chain.mint_musdc_ix(&pk, TOP_UP_USDC));
        }
        if !ixs.is_empty() {
            match chain.send_admin(&ixs, &[]).await {
                Ok(_) => tracing::info!(bot = %pk, "funded bot"),
                Err(e) => tracing::warn!(bot = %pk, error = %e, "funding bot failed"),
            }
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum Action {
    BuyYes,
    SellYes,
    BuyNo,
    SellNo,
}

fn pick_action(rng: &mut impl Rng) -> Action {
    match rng.gen_range(0..100) {
        0..=29 => Action::BuyYes,
        30..=49 => Action::SellYes,
        50..=79 => Action::BuyNo,
        _ => Action::SellNo,
    }
}

/// Mint a fresh batch of complete sets for the bot (creates YES/NO ATAs if needed).
async fn restock(chain: &Chain, m: &ActiveMarket, bot: &Keypair) -> Result<()> {
    let pk = bot.pubkey();
    chain
        .send(
            &[
                create_ata_ix(&pk, &pk, &m.addrs.yes_mint),
                create_ata_ix(&pk, &pk, &m.addrs.no_mint),
                program::mint_set_ix(&chain.program_id, &m.addrs, &chain.musdc, &pk, STARTING_SETS),
            ],
            bot,
            &[],
        )
        .await
        .context("bot mint_complete_set")?;
    tracing::info!(bot = %pk, market = m.id, "bot minted starting sets");
    Ok(())
}

/// Do one random trade. Returns whether the bot is stocked (ATAs + inventory) for this market.
pub async fn act(chain: &Chain, db: &PgPool, m: &ActiveMarket, bot: &Keypair, fair: f64, stocked: bool) -> Result<bool> {
    if !stocked {
        // After a restart the in-memory flag is gone; only mint if the bot really holds nothing.
        let yes = chain.ata_balance(&bot.pubkey(), &m.addrs.yes_mint).await;
        let no = chain.ata_balance(&bot.pubkey(), &m.addrs.no_mint).await;
        if yes.min(no) < 20 * TOKEN {
            restock(chain, m, bot).await?;
            return Ok(true);
        }
    }
    let (action, size_tokens, noise) = {
        let mut rng = rand::thread_rng();
        (pick_action(&mut rng), rng.gen_range(1..=20i64), rng.gen_range(0..=3i64))
    };
    let base_lots = size_tokens * openbook::BASE_LOTS_PER_TOKEN;
    let yes_fair = fair.round() as i64;
    let no_fair = 100 - yes_fair;

    let (book, book_name, side, side_name, limit, mint) = match action {
        Action::BuyYes => (&m.yes, "yes", openbook::Side::Bid, "buy", clamp_cents(yes_fair + noise), m.addrs.yes_mint),
        Action::SellYes => (&m.yes, "yes", openbook::Side::Ask, "sell", clamp_cents(yes_fair - noise), m.addrs.yes_mint),
        Action::BuyNo => (&m.no, "no", openbook::Side::Bid, "buy", clamp_cents(no_fair + noise), m.addrs.no_mint),
        Action::SellNo => (&m.no, "no", openbook::Side::Ask, "sell", clamp_cents(no_fair - noise), m.addrs.no_mint),
    };

    // Sells need inventory: if low, restock this turn instead.
    if side == openbook::Side::Ask {
        let held = chain.ata_balance(&bot.pubkey(), &mint).await;
        if held < size_tokens as u64 * TOKEN {
            restock(chain, m, bot).await?;
            return Ok(true);
        }
    }

    let ix = openbook::place_take_order_ix(book, &bot.pubkey(), side, limit, base_lots);
    let sig = chain.send(&[ix], bot, &[]).await.context("place_take_order")?;
    db::insert_bot_trade(
        db,
        &db::BotTrade {
            market_id: m.id,
            book: book_name,
            bot: bot.pubkey().to_string(),
            side: side_name,
            size_lots: base_lots,
            limit_cents: limit as i32,
            tx: sig,
        },
    )
    .await?;
    tracing::debug!(market = m.id, ?action, size_tokens, limit, "bot traded");
    Ok(true)
}
