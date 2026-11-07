use anchor_lang::prelude::Pubkey;
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{str::FromStr, sync::Arc};

use crate::{
    chain::{create_ata_ix, transfer_sol_ix},
    db,
    markets::{self, CreateMarketReq, TOKEN},
    AppState,
};

const FAUCET_USDC: u64 = 1_000 * TOKEN;

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/config", get(public_config))
        .route("/markets", get(list_markets).post(create_market))
        .route("/public/markets", post(create_market_public))
        .route("/markets/{id}", get(get_market))
        .route("/markets/{id}/resolve", post(resolve_market))
        .route("/markets/{id}/trades", get(market_trades))
        .route("/faucet", post(faucet))
        .route("/bots/start", post(bots_start))
        .route("/bots/stop", post(bots_stop))
        .route("/bots/status", get(bots_status))
        .with_state(state)
}

pub struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}"))
    }
}

fn bad_request(msg: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, msg.into())
}

type ApiResult = Result<Json<Value>, ApiError>;

fn require_admin(state: &AppState, headers: &HeaderMap) -> Result<(), ApiError> {
    match headers.get("x-admin-key").and_then(|v| v.to_str().ok()) {
        Some(k) if k == state.cfg.admin_api_key => Ok(()),
        _ => Err(ApiError(StatusCode::UNAUTHORIZED, "missing or wrong x-admin-key".into())),
    }
}

async fn health() -> &'static str {
    "ok"
}

/// Addresses the frontend needs (no secrets).
async fn public_config(State(s): State<Arc<AppState>>) -> ApiResult {
    Ok(Json(json!({
        "rpc_url": s.cfg.public_rpc_url,
        "program_id": s.chain.program_id.to_string(),
        "openbook_program_id": s.chain.openbook_id.to_string(),
        "musdc_mint": s.chain.musdc.to_string(),
        "admin": s.chain.admin_pk().to_string(),
    })))
}

#[derive(Deserialize)]
struct ListQuery {
    status: Option<String>,
}

async fn list_markets(State(s): State<Arc<AppState>>, Query(q): Query<ListQuery>) -> ApiResult {
    let markets = db::list_markets(&s.db, q.status.as_deref()).await?;
    Ok(Json(json!(markets)))
}

async fn get_market(State(s): State<Arc<AppState>>, Path(id): Path<i64>) -> ApiResult {
    match db::get_market(&s.db, id).await? {
        Some(m) => Ok(Json(json!(m))),
        None => Err(ApiError(StatusCode::NOT_FOUND, "market not found".into())),
    }
}

async fn market_trades(State(s): State<Arc<AppState>>, Path(id): Path<i64>) -> ApiResult {
    Ok(Json(json!(db::recent_bot_trades(&s.db, id, 200).await?)))
}

async fn create_market(State(s): State<Arc<AppState>>, headers: HeaderMap, Json(req): Json<CreateMarketReq>) -> ApiResult {
    require_admin(&s, &headers)?;
    req.validate().map_err(|e| bad_request(e.to_string()))?;
    let c = s.markets.create(&s.chain, &s.db, &req).await?;
    let m = db::get_market(&s.db, c.id).await?;
    Ok(Json(json!(m)))
}

/// Anyone can create a market from a question (e.g. a search query). Liquidity is seeded by the
/// admin wallet with the default ladder. The same question (normalized) returns the existing market.
#[derive(Deserialize)]
struct PublicCreateReq {
    question: String,
    description: Option<String>,
    resolution_time: chrono::DateTime<chrono::Utc>,
    initial_price_cents: Option<i64>,
}

async fn create_market_public(State(s): State<Arc<AppState>>, Json(req): Json<PublicCreateReq>) -> ApiResult {
    let req = CreateMarketReq {
        question: req.question,
        description: req.description.filter(|d| !d.trim().is_empty()),
        resolution_time: req.resolution_time,
        initial_price_cents: req.initial_price_cents.unwrap_or(50),
        seed_sets: 1000,
        levels: 5,
        level_size: 50,
    };
    req.validate().map_err(|e| bad_request(e.to_string()))?;
    let c = s.markets.create(&s.chain, &s.db, &req).await?;
    let m = db::get_market(&s.db, c.id).await?;
    Ok(Json(json!({ "created": c.created, "market": m })))
}

#[derive(Deserialize)]
struct ResolveReq {
    outcome: String,
}

async fn resolve_market(
    State(s): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(req): Json<ResolveReq>,
) -> ApiResult {
    require_admin(&s, &headers)?;
    markets::parse_outcome(&req.outcome).map_err(|e| bad_request(e.to_string()))?;
    let m = db::get_market(&s.db, id).await?.ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "market not found".into()))?;
    if m.market.status != "active" {
        return Err(bad_request(format!("market is {}, not active", m.market.status)));
    }
    if chrono::Utc::now() < m.market.resolution_time {
        return Err(bad_request(format!("resolution time {} not reached yet", m.market.resolution_time)));
    }
    let tx = markets::resolve(&s.chain, &s.db, id, &req.outcome).await?;
    Ok(Json(json!({ "id": id, "outcome": req.outcome, "tx": tx })))
}

#[derive(Deserialize)]
struct FaucetReq {
    wallet: String,
}

async fn faucet(State(s): State<Arc<AppState>>, Json(req): Json<FaucetReq>) -> ApiResult {
    let wallet = Pubkey::from_str(req.wallet.trim()).map_err(|_| bad_request("invalid wallet pubkey"))?;
    let key = wallet.to_string();
    if !db::try_faucet_claim(&s.db, &key).await? {
        return Err(ApiError(StatusCode::TOO_MANY_REQUESTS, "faucet: 1 claim per wallet per hour".into()));
    }
    let admin = s.chain.admin_pk();
    let mut ixs = vec![];
    if s.cfg.faucet_sol_lamports > 0 && s.chain.sol_balance(&wallet).await < s.cfg.faucet_sol_lamports {
        ixs.push(transfer_sol_ix(&admin, &wallet, s.cfg.faucet_sol_lamports));
    }
    ixs.push(create_ata_ix(&admin, &wallet, &s.chain.musdc));
    ixs.push(s.chain.mint_musdc_ix(&wallet, FAUCET_USDC));
    match s.chain.send_admin(&ixs, &[]).await {
        Ok(tx) => Ok(Json(json!({ "wallet": key, "musdc": FAUCET_USDC / TOKEN, "tx": tx }))),
        Err(e) => {
            db::undo_faucet_claim(&s.db, &key).await?;
            Err(e.into())
        }
    }
}

async fn bots_start(State(s): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    require_admin(&s, &headers)?;
    s.bots.set_running(true);
    Ok(Json(json!({ "running": true })))
}

async fn bots_stop(State(s): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    require_admin(&s, &headers)?;
    s.bots.set_running(false);
    Ok(Json(json!({ "running": false })))
}

async fn bots_status(State(s): State<Arc<AppState>>) -> ApiResult {
    Ok(Json(json!(s.bots.status(&s.chain, &s.db).await?)))
}
