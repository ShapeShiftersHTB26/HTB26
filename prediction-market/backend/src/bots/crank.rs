//! Crank: consume fill events on both books.
//! In the MVP only the market maker rests orders, so every fill's maker is the admin's
//! open-orders account for that book and we never need to decode the event heap.

use super::ActiveMarket;
use crate::chain::{openbook, Chain};

pub async fn crank_market(chain: &Chain, m: &ActiveMarket) {
    for (book, oo) in [(&m.yes, m.yes_oo), (&m.no, m.no_oo)] {
        let pending = match chain.rpc.get_account_data(&book.event_heap).await {
            Ok(data) => openbook::parse_event_heap_count(&data).unwrap_or(0),
            Err(_) => 0,
        };
        if pending == 0 {
            continue;
        }
        let ix = openbook::consume_events_ix(book, 10, &[oo]);
        match chain.send_admin(&[ix], &[]).await {
            Ok(_) => tracing::debug!(market = m.id, pending, "cranked"),
            Err(e) => tracing::warn!(market = m.id, error = %e, "crank failed"),
        }
    }
}
