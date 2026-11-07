mod bootstrap;
mod bots;
mod chain;
mod config;
mod db;
mod markets;
mod routes;

use anyhow::Result;
use sqlx::PgPool;
use std::sync::Arc;
use tower_http::{cors::CorsLayer, trace::TraceLayer};

pub struct AppState {
    pub cfg: config::Config,
    pub db: PgPool,
    pub chain: chain::SharedChain,
    pub markets: markets::Markets,
    pub bots: Arc<bots::BotManager>,
}

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "pm_backend=info,tower_http=info".into()),
        )
        .init();

    let cfg = config::Config::from_env()?;

    // `pm-backend bootstrap` (alias `init-config`): idempotent chain setup — admin funding (local),
    // mUSDC mint, program Config. BOOTSTRAP_ON_START=true runs it before serving (Docker).
    let cmd = std::env::args().nth(1);
    if matches!(cmd.as_deref(), Some("bootstrap") | Some("init-config")) {
        return bootstrap::run(&cfg).await;
    }
    if std::env::var("BOOTSTRAP_ON_START").as_deref() == Ok("true") {
        bootstrap::run(&cfg).await?;
    }

    let db = db::connect(&cfg.database_url).await?;
    let chain = Arc::new(chain::Chain::new(&cfg)?);
    tracing::info!(admin = %chain.admin_pk(), rpc = %cfg.rpc_url, "chain ready");

    let bots = Arc::new(bots::BotManager::new(&cfg)?);
    bots.clone().spawn(chain.clone(), db.clone());

    let state = Arc::new(AppState { cfg: cfg.clone(), db, chain, markets: markets::Markets::new(), bots });
    if cfg.demo_markets {
        let s = state.clone();
        tokio::spawn(async move {
            if let Err(e) = bootstrap::seed_demo_markets(&s.chain, &s.db, &s.markets).await {
                tracing::error!(error = %format!("{e:#}"), "creating demo markets failed");
            }
        });
    }
    let app = routes::router(state).layer(CorsLayer::permissive()).layer(TraceLayer::new_for_http());

    let listener = tokio::net::TcpListener::bind(&cfg.bind_addr).await?;
    tracing::info!(addr = %cfg.bind_addr, "API listening");
    axum::serve(listener, app).await?;
    Ok(())
}
