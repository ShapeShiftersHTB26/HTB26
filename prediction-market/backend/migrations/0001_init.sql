create table markets (
  id                  bigserial primary key,        -- also the on-chain Market id seed
  question            text not null,
  description         text,
  status              text not null default 'pending',  -- pending | active | resolved | failed
  outcome             text,                             -- yes | no | void
  resolution_time     timestamptz not null,
  initial_price_cents int  not null,                    -- initial YES price; NO starts at 100 - this
  seed_sets           bigint not null,                  -- complete sets minted for liquidity (base units)
  levels              int  not null,
  level_size          bigint not null,                  -- tokens per ladder level
  market_pda          text unique,
  yes_mint            text,
  no_mint             text,
  vault               text,
  create_txs          text[] not null default '{}',
  error               text,
  created_at          timestamptz not null default now(),
  resolved_at         timestamptz
);

-- one row per OpenBook market: two per question
create table orderbooks (
  market_id           bigint not null references markets(id),
  outcome             text   not null check (outcome in ('yes', 'no')),
  ob_market           text   not null unique,
  bids                text   not null,
  asks                text   not null,
  event_heap          text   not null,
  admin_open_orders   text   not null,              -- market maker's open-orders account on this book
  primary key (market_id, outcome)
);

create table bot_trades (
  id          bigserial primary key,
  market_id   bigint not null references markets(id),
  book        text   not null,        -- yes | no
  bot         text   not null,        -- bot pubkey
  side        text   not null,        -- buy | sell
  size_lots   bigint not null,
  limit_cents int    not null,
  tx          text   not null,
  created_at  timestamptz not null default now()
);
create index bot_trades_market_created on bot_trades (market_id, created_at desc);

create table faucet_claims (
  wallet      text primary key,
  last_claim  timestamptz not null
);
