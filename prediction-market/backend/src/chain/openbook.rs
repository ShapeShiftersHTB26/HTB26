//! Hand-built OpenBook v2 instructions.
//!
//! OpenBook's published IDL is in the legacy Anchor format, so instead of generating
//! bindings we build the handful of instructions we need directly:
//! data = sha256("global:<name>")[..8] ++ borsh(args); account order copied from
//! `idl/openbook_v2.json` in github.com/openbook-dex/openbook-v2.
//! Optional accounts that are absent are passed as the OpenBook program id (Anchor convention).

use anchor_lang::{
    prelude::{AccountMeta, Pubkey},
    solana_program::{instruction::Instruction, system_program},
};
use anchor_spl::{associated_token, token::spl_token};
use borsh::BorshSerialize;
use sha2::{Digest, Sha256};

use super::{ata, readonly, writable};

pub const BOOKSIDE_SPACE: u64 = 90944 + 8;
pub const EVENT_HEAP_SPACE: u64 = 91280 + 8;
/// Offset of `EventHeapHeader.count` (u16): 8-byte discriminator + free_head u16 + used_head u16.
const EVENT_HEAP_COUNT_OFFSET: usize = 8 + 4;

// ---------- borsh arg types (mirror openbook_v2::state / lib.rs) ----------

#[derive(BorshSerialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Bid,
    Ask,
}

#[allow(dead_code)]
#[derive(BorshSerialize, Clone, Copy, Debug)]
pub enum PlaceOrderType {
    Limit,
    ImmediateOrCancel,
    PostOnly,
    Market,
    PostOnlySlide,
    FillOrKill,
}

#[derive(BorshSerialize)]
struct OracleConfigParams {
    conf_filter: f32,
    max_staleness_slots: Option<u32>,
}

#[derive(BorshSerialize, Clone, Copy, Debug)]
pub struct PlaceMultipleOrdersArgs {
    pub price_lots: i64,
    pub max_quote_lots_including_fees: i64,
    pub expiry_timestamp: u64,
}

#[derive(BorshSerialize)]
struct PlaceTakeOrderArgs {
    side: Side,
    price_lots: i64,
    max_base_lots: i64,
    max_quote_lots_including_fees: i64,
    order_type: PlaceOrderType,
    limit: u8,
}

fn data<T: BorshSerialize>(name: &str, args: &T) -> Vec<u8> {
    let mut out = Sha256::digest(format!("global:{name}").as_bytes())[..8].to_vec();
    args.serialize(&mut out).expect("borsh");
    out
}

/// Market params shared by every YES/NO book (see PLAN §5). With 6-decimal tokens:
/// price_lots == price in cents, 1 base lot == 0.01 token.
pub const BASE_LOT_SIZE: i64 = 10_000;
pub const QUOTE_LOT_SIZE: i64 = 100;
pub const BASE_LOTS_PER_TOKEN: i64 = 100;

/// All addresses needed to trade on one OpenBook market.
#[derive(Clone, Debug)]
pub struct Book {
    pub program_id: Pubkey,
    pub market: Pubkey,
    pub bids: Pubkey,
    pub asks: Pubkey,
    pub event_heap: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
}

impl Book {
    pub fn market_authority(&self) -> Pubkey {
        Pubkey::find_program_address(&[b"Market", self.market.as_ref()], &self.program_id).0
    }
    pub fn base_vault(&self) -> Pubkey {
        ata(&self.market_authority(), &self.base_mint)
    }
    pub fn quote_vault(&self) -> Pubkey {
        ata(&self.market_authority(), &self.quote_mint)
    }
    fn none(&self) -> AccountMeta {
        readonly(self.program_id)
    }
}

pub fn event_authority(program_id: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"__event_authority"], program_id).0
}

pub fn open_orders_indexer(program_id: &Pubkey, owner: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"OpenOrdersIndexer", owner.as_ref()], program_id).0
}

/// Open-orders accounts are numbered per owner: seeds = ["OpenOrders", owner, counter_u32_le].
pub fn open_orders_account(program_id: &Pubkey, owner: &Pubkey, counter: u32) -> Pubkey {
    Pubkey::find_program_address(&[b"OpenOrders", owner.as_ref(), &counter.to_le_bytes()], program_id).0
}

/// `OpenOrdersIndexer { bump: u8, created_counter: u32, addresses: Vec<Pubkey> }` after the discriminator.
pub fn parse_indexer_counter(data: &[u8]) -> Option<u32> {
    data.get(9..13).map(|b| u32::from_le_bytes(b.try_into().unwrap()))
}

pub fn parse_event_heap_count(data: &[u8]) -> Option<u16> {
    data.get(EVENT_HEAP_COUNT_OFFSET..EVENT_HEAP_COUNT_OFFSET + 2)
        .map(|b| u16::from_le_bytes(b.try_into().unwrap()))
}

/// `create_market` (accounts bids/asks/event_heap must be pre-created, zeroed, owned by OpenBook).
pub fn create_market_ix(
    book: &Book,
    payer: &Pubkey,
    name: &str,
    time_expiry: i64,
    admin: &Pubkey,
) -> Instruction {
    #[derive(BorshSerialize)]
    struct Args {
        name: String,
        oracle_config: OracleConfigParams,
        quote_lot_size: i64,
        base_lot_size: i64,
        maker_fee: i64,
        taker_fee: i64,
        time_expiry: i64,
    }
    let args = Args {
        name: name.to_string(),
        oracle_config: OracleConfigParams { conf_filter: 0.1, max_staleness_slots: None },
        quote_lot_size: QUOTE_LOT_SIZE,
        base_lot_size: BASE_LOT_SIZE,
        maker_fee: 0,
        taker_fee: 0,
        time_expiry,
    };
    let accounts = vec![
        AccountMeta::new(book.market, true),
        readonly(book.market_authority()),
        writable(book.bids),
        writable(book.asks),
        writable(book.event_heap),
        AccountMeta::new(*payer, true),
        writable(book.base_vault()),
        writable(book.quote_vault()),
        readonly(book.base_mint),
        readonly(book.quote_mint),
        readonly(system_program::ID),
        readonly(spl_token::ID),
        readonly(associated_token::ID),
        book.none(),       // oracle_a
        book.none(),       // oracle_b
        readonly(*admin),  // collect_fee_admin
        book.none(),       // open_orders_admin: anyone can trade
        book.none(),       // consume_events_admin: anyone can crank
        readonly(*admin),  // close_market_admin
        readonly(event_authority(&book.program_id)),
        readonly(book.program_id),
    ];
    Instruction { program_id: book.program_id, accounts, data: data("create_market", &args) }
}

pub fn create_open_orders_indexer_ix(program_id: &Pubkey, payer: &Pubkey, owner: &Pubkey) -> Instruction {
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(*owner, true),
            writable(open_orders_indexer(program_id, owner)),
            readonly(system_program::ID),
        ],
        data: data("create_open_orders_indexer", &()),
    }
}

pub fn create_open_orders_account_ix(
    program_id: &Pubkey,
    payer: &Pubkey,
    owner: &Pubkey,
    market: &Pubkey,
    open_orders: &Pubkey,
    name: &str,
) -> Instruction {
    #[derive(BorshSerialize)]
    struct Args {
        name: String,
    }
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(*owner, true),
            readonly(*program_id), // delegate_account: none
            writable(open_orders_indexer(program_id, owner)),
            writable(*open_orders),
            readonly(*market),
            readonly(system_program::ID),
        ],
        data: data("create_open_orders_account", &Args { name: name.to_string() }),
    }
}

/// A resting order: price in cents, size in base lots (0.01 token).
#[derive(Clone, Copy, Debug)]
pub struct Quote {
    pub price_lots: i64,
    pub base_lots: i64,
}

impl Quote {
    fn args(&self) -> PlaceMultipleOrdersArgs {
        // OpenBook sizes multi-orders by quote lots: base_lots * price_lots (0 fees).
        PlaceMultipleOrdersArgs {
            price_lots: self.price_lots,
            max_quote_lots_including_fees: self.base_lots * self.price_lots,
            expiry_timestamp: 0,
        }
    }
}

/// `place_orders` / `cancel_all_and_place_orders` (PostOnly so the MM never crosses itself).
pub fn place_orders_ix(
    book: &Book,
    owner: &Pubkey,
    open_orders: &Pubkey,
    bids: &[Quote],
    asks: &[Quote],
    cancel_all_first: bool,
) -> Instruction {
    #[derive(BorshSerialize)]
    struct Args {
        orders_type: PlaceOrderType,
        bids: Vec<PlaceMultipleOrdersArgs>,
        asks: Vec<PlaceMultipleOrdersArgs>,
        limit: u8,
    }
    let args = Args {
        orders_type: PlaceOrderType::PostOnlySlide,
        bids: bids.iter().map(Quote::args).collect(),
        asks: asks.iter().map(Quote::args).collect(),
        limit: 10,
    };
    let name = if cancel_all_first { "cancel_all_and_place_orders" } else { "place_orders" };
    Instruction {
        program_id: book.program_id,
        accounts: vec![
            AccountMeta::new_readonly(*owner, true),
            writable(*open_orders),
            book.none(), // open_orders_admin
            writable(ata(owner, &book.quote_mint)),
            writable(ata(owner, &book.base_mint)),
            writable(book.market),
            writable(book.bids),
            writable(book.asks),
            writable(book.event_heap),
            writable(book.quote_vault()),
            writable(book.base_vault()),
            book.none(), // oracle_a
            book.none(), // oracle_b
            readonly(spl_token::ID),
        ],
        data: data(name, &args),
    }
}

/// Immediate-or-cancel take order that settles straight into the signer's ATAs.
pub fn place_take_order_ix(book: &Book, signer: &Pubkey, side: Side, price_lots: i64, base_lots: i64) -> Instruction {
    let max_quote = match side {
        Side::Bid => base_lots * price_lots,
        // Proceeds can't exceed size * 99¢; OpenBook rejects caps above i64::MAX / quote_lot_size.
        Side::Ask => base_lots * 100,
    };
    let args = PlaceTakeOrderArgs {
        side,
        price_lots,
        max_base_lots: base_lots,
        max_quote_lots_including_fees: max_quote,
        order_type: PlaceOrderType::ImmediateOrCancel,
        limit: 10,
    };
    Instruction {
        program_id: book.program_id,
        accounts: vec![
            AccountMeta::new(*signer, true),
            AccountMeta::new(*signer, true), // penalty_payer
            writable(book.market),
            readonly(book.market_authority()),
            writable(book.bids),
            writable(book.asks),
            writable(book.base_vault()),
            writable(book.quote_vault()),
            writable(book.event_heap),
            writable(ata(signer, &book.base_mint)),
            writable(ata(signer, &book.quote_mint)),
            book.none(), // oracle_a
            book.none(), // oracle_b
            readonly(spl_token::ID),
            readonly(system_program::ID),
            book.none(), // open_orders_admin
        ],
        data: data("place_take_order", &args),
    }
}

/// Crank: process up to `limit` fill/out events. `makers` = open-orders accounts referenced by those events.
pub fn consume_events_ix(book: &Book, limit: u64, makers: &[Pubkey]) -> Instruction {
    let mut accounts = vec![book.none(), writable(book.market), writable(book.event_heap)];
    accounts.extend(makers.iter().map(|m| writable(*m)));
    Instruction { program_id: book.program_id, accounts, data: data("consume_events", &limit) }
}

pub fn settle_funds_ix(book: &Book, owner: &Pubkey, open_orders: &Pubkey) -> Instruction {
    Instruction {
        program_id: book.program_id,
        accounts: vec![
            AccountMeta::new(*owner, true),
            AccountMeta::new(*owner, true), // penalty_payer
            writable(*open_orders),
            writable(book.market),
            readonly(book.market_authority()),
            writable(book.base_vault()),
            writable(book.quote_vault()),
            writable(ata(owner, &book.base_mint)),
            writable(ata(owner, &book.quote_mint)),
            book.none(), // referrer_account
            readonly(spl_token::ID),
            readonly(system_program::ID),
        ],
        data: data("settle_funds", &()),
    }
}

pub fn cancel_all_orders_ix(book: &Book, owner: &Pubkey, open_orders: &Pubkey) -> Instruction {
    #[derive(BorshSerialize)]
    struct Args {
        side_option: Option<Side>,
        limit: u8,
    }
    Instruction {
        program_id: book.program_id,
        accounts: vec![
            AccountMeta::new_readonly(*owner, true),
            writable(*open_orders),
            readonly(book.market),
            writable(book.bids),
            writable(book.asks),
        ],
        data: data("cancel_all_orders", &Args { side_option: None, limit: 255 }),
    }
}
