//! Market maker (admin wallet): settle → rebalance inventory → re-quote both books
//! around one fair price so YES ask + NO ask > 100¢ and YES bid + NO bid < 100¢ (PLAN §5.1).

use anyhow::{Context, Result};

use super::ActiveMarket;
use crate::{
    chain::{create_ata_ix, openbook, program, Chain},
    markets::{bid_notional, ladder, TOKEN},
};

pub async fn requote(chain: &Chain, m: &ActiveMarket, fair: f64) -> Result<()> {
    let admin = chain.admin_pk();

    // 1. Pull filled proceeds back into the admin's token accounts.
    chain
        .send_admin(
            &[
                openbook::settle_funds_ix(&m.yes, &admin, &m.yes_oo),
                openbook::settle_funds_ix(&m.no, &admin, &m.no_oo),
            ],
            &[],
        )
        .await
        .context("settle_funds")?;

    // 2. Rebalance: keep ~2 ladders of YES and NO and enough mUSDC for both bid ladders.
    let center = fair.round() as i64;
    let (yes_bids, yes_asks) = ladder(center, m.levels, m.level_size);
    let (no_bids, no_asks) = ladder(100 - center, m.levels, m.level_size);
    let target = 2 * (m.levels * m.level_size) as u64 * TOKEN;
    let yes = chain.ata_balance(&admin, &m.addrs.yes_mint).await;
    let no = chain.ata_balance(&admin, &m.addrs.no_mint).await;
    let usdc = chain.ata_balance(&admin, &chain.musdc).await;
    let usdc_for_bids = bid_notional(&yes_bids) + bid_notional(&no_bids);

    let mut ixs = vec![];
    let low = yes.min(no);
    let to_mint_sets = if low < target { target * 2 - low } else { 0 };
    let usdc_needed = usdc_for_bids + to_mint_sets;
    if usdc < usdc_needed {
        ixs.push(create_ata_ix(&admin, &admin, &chain.musdc));
        ixs.push(chain.mint_musdc_ix(&admin, usdc_needed - usdc));
    }
    if to_mint_sets > 0 {
        ixs.push(program::mint_set_ix(&chain.program_id, &m.addrs, &chain.musdc, &admin, to_mint_sets));
    } else if low > target * 4 {
        ixs.push(program::merge_set_ix(&chain.program_id, &m.addrs, &chain.musdc, &admin, low - target * 2));
    }
    if !ixs.is_empty() {
        chain.send_admin(&ixs, &[]).await.context("rebalance inventory")?;
    }

    // 3. Replace both ladders. Both instructions together exceed the 1232-byte tx limit,
    //    so they go back to back (each one is an atomic cancel-all + place on its book).
    chain
        .send_admin(&[openbook::place_orders_ix(&m.yes, &admin, &m.yes_oo, &yes_bids, &yes_asks, true)], &[])
        .await
        .context("cancel_all_and_place_orders YES")?;
    chain
        .send_admin(&[openbook::place_orders_ix(&m.no, &admin, &m.no_oo, &no_bids, &no_asks, true)], &[])
        .await
        .context("cancel_all_and_place_orders NO")?;
    tracing::debug!(market = m.id, center, "re-quoted");
    Ok(())
}
