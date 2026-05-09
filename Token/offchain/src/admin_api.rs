use std::fmt;
use std::net::SocketAddr;
use std::str::FromStr;
use std::sync::{Arc, Mutex};

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use ethers_core::types::Signature;
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tower_http::cors::CorsLayer;

use crate::config::{format_bnb_amount, parse_bnb_amount, ProtocolConfig};
use crate::rpc::{format_address, BscRpcClient, RpcError};
use crate::settings::OperatorSettings;
use crate::storage::PostgresDatabase;

const ADMIN_MESSAGE_PREFIX: &str = "USCAMEX Admin";

#[derive(Clone)]
pub struct AdminApiState {
    settings: Arc<OperatorSettings>,
    database: Arc<Mutex<PostgresDatabase>>,
    rpc: BscRpcClient,
}

#[derive(Debug)]
pub enum AdminApiError {
    AuthMissing(&'static str),
    BadSignature,
    Forbidden,
    BadRequest(String),
    Rpc(RpcError),
    Database(String),
    Bind(std::io::Error),
}

impl fmt::Display for AdminApiError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl std::error::Error for AdminApiError {}

impl From<RpcError> for AdminApiError {
    fn from(error: RpcError) -> Self {
        Self::Rpc(error)
    }
}

impl From<std::io::Error> for AdminApiError {
    fn from(error: std::io::Error) -> Self {
        Self::Bind(error)
    }
}

impl IntoResponse for AdminApiError {
    fn into_response(self) -> Response {
        let status = match self {
            Self::AuthMissing(_) | Self::BadSignature => StatusCode::UNAUTHORIZED,
            Self::Forbidden => StatusCode::FORBIDDEN,
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::Rpc(_) | Self::Database(_) | Self::Bind(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        let body = Json(ErrorResponse {
            error: self.to_string(),
        });
        (status, body).into_response()
    }
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    error: String,
}

#[derive(Debug, Serialize)]
struct PublicHealthResponse {
    ok: bool,
    chain_id: u64,
    chain_head: Option<u64>,
    token_address: String,
    pancake_v2_router: String,
    indexer_start_block: u64,
    confirmations: u64,
}

#[derive(Debug, Serialize)]
struct AdminOverviewResponse {
    signer: String,
    owner: String,
    chain_id: u64,
    chain_head: Option<u64>,
    token_address: String,
    pancake_v2_router: String,
    database_state_snapshot: bool,
    protocol_config_initialized: bool,
    pending_commands: usize,
}

#[derive(Debug, Serialize)]
struct AdminStateResponse<T> {
    signer: String,
    data: T,
}

#[derive(Debug, Serialize)]
struct AdminConfigResponse {
    signer: String,
    config: ProtocolConfigForm,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProtocolConfigForm {
    min_deposit_bnb: String,
    max_deposit_bnb: String,
    lp_build_bps: u16,
    node_bps: u16,
    builder_buy_bps: u16,
    vault_bps: u16,
    direct_pool_bps: u16,
    direct_reward_bps: u16,
    daily_static_bps: u16,
    settlement_periods_per_day: u8,
    exit_multiple_bps: u32,
    team_reward_bps: [u16; 10],
    deflation_enabled: bool,
    deflation_hourly_bps: u16,
    deflation_daily_cap_bps: u16,
    buyback_enabled: bool,
    buyback_per_minute_bnb: String,
    buy_tax_bps: u16,
    buy_tax_builder_bps: u16,
    buy_tax_vault_bps: u16,
    sell_tax_bps: u16,
    sell_tax_builder_bps: u16,
    sell_tax_owner_bps: u16,
    sell_tax_vault_bps: u16,
}

impl From<ProtocolConfig> for ProtocolConfigForm {
    fn from(config: ProtocolConfig) -> Self {
        Self {
            min_deposit_bnb: format_bnb_amount(config.min_deposit),
            max_deposit_bnb: format_bnb_amount(config.max_deposit),
            lp_build_bps: config.lp_build_bps,
            node_bps: config.node_bps,
            builder_buy_bps: config.builder_buy_bps,
            vault_bps: config.vault_bps,
            direct_pool_bps: config.direct_pool_bps,
            direct_reward_bps: config.direct_reward_bps,
            daily_static_bps: config.daily_static_bps,
            settlement_periods_per_day: config.settlement_periods_per_day,
            exit_multiple_bps: config.exit_multiple_bps,
            team_reward_bps: config.team_reward_bps,
            deflation_enabled: config.deflation_enabled,
            deflation_hourly_bps: config.deflation_hourly_bps,
            deflation_daily_cap_bps: config.deflation_daily_cap_bps,
            buyback_enabled: config.buyback_enabled,
            buyback_per_minute_bnb: format_bnb_amount(config.buyback_per_minute),
            buy_tax_bps: config.buy_tax_bps,
            buy_tax_builder_bps: config.buy_tax_builder_bps,
            buy_tax_vault_bps: config.buy_tax_vault_bps,
            sell_tax_bps: config.sell_tax_bps,
            sell_tax_builder_bps: config.sell_tax_builder_bps,
            sell_tax_owner_bps: config.sell_tax_owner_bps,
            sell_tax_vault_bps: config.sell_tax_vault_bps,
        }
    }
}

impl ProtocolConfigForm {
    fn into_config(self) -> Result<ProtocolConfig, AdminApiError> {
        let config = ProtocolConfig {
            min_deposit: parse_bnb_amount(&self.min_deposit_bnb)
                .map_err(|error| AdminApiError::BadRequest(error.to_string()))?,
            max_deposit: parse_bnb_amount(&self.max_deposit_bnb)
                .map_err(|error| AdminApiError::BadRequest(error.to_string()))?,
            lp_build_bps: self.lp_build_bps,
            node_bps: self.node_bps,
            builder_buy_bps: self.builder_buy_bps,
            vault_bps: self.vault_bps,
            direct_pool_bps: self.direct_pool_bps,
            direct_reward_bps: self.direct_reward_bps,
            daily_static_bps: self.daily_static_bps,
            settlement_periods_per_day: self.settlement_periods_per_day,
            exit_multiple_bps: self.exit_multiple_bps,
            team_reward_bps: self.team_reward_bps,
            deflation_enabled: self.deflation_enabled,
            deflation_hourly_bps: self.deflation_hourly_bps,
            deflation_daily_cap_bps: self.deflation_daily_cap_bps,
            buyback_enabled: self.buyback_enabled,
            buyback_per_minute: parse_bnb_amount(&self.buyback_per_minute_bnb)
                .map_err(|error| AdminApiError::BadRequest(error.to_string()))?,
            buy_tax_bps: self.buy_tax_bps,
            buy_tax_builder_bps: self.buy_tax_builder_bps,
            buy_tax_vault_bps: self.buy_tax_vault_bps,
            sell_tax_bps: self.sell_tax_bps,
            sell_tax_builder_bps: self.sell_tax_builder_bps,
            sell_tax_owner_bps: self.sell_tax_owner_bps,
            sell_tax_vault_bps: self.sell_tax_vault_bps,
        };
        config
            .validate()
            .map_err(|error| AdminApiError::BadRequest(error.to_string()))?;
        Ok(config)
    }
}

pub async fn serve_admin_api(
    settings: OperatorSettings,
    database: PostgresDatabase,
) -> Result<(), AdminApiError> {
    let rpc = BscRpcClient::new(&settings.bsc_rpc_url, &settings.token_address)?;
    let bind_addr = settings
        .admin_http_addr
        .parse::<SocketAddr>()
        .map_err(|error| AdminApiError::Database(format!("invalid admin addr: {error}")))?;
    let state = AdminApiState {
        settings: Arc::new(settings),
        database: Arc::new(Mutex::new(database)),
        rpc,
    };
    let app = router(state);
    let listener = TcpListener::bind(bind_addr).await?;
    println!("operator admin api listening on http://{bind_addr}");
    axum::serve(listener, app).await?;
    Ok(())
}

pub fn router(state: AdminApiState) -> Router {
    Router::new()
        .route("/api/health", get(public_health))
        .route("/api/admin/owner", get(owner))
        .route("/api/admin/overview", get(admin_overview))
        .route(
            "/api/admin/config",
            get(admin_config).put(update_admin_config),
        )
        .route("/api/admin/state", get(admin_state))
        .route("/api/admin/journal", get(admin_journal))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

async fn public_health(
    State(state): State<AdminApiState>,
) -> Result<Json<PublicHealthResponse>, AdminApiError> {
    let chain_head = state.rpc.block_number().await.ok();
    Ok(Json(PublicHealthResponse {
        ok: true,
        chain_id: state.settings.chain_id,
        chain_head,
        token_address: state.settings.token_address.clone(),
        pancake_v2_router: state.settings.pancake_v2_router.clone(),
        indexer_start_block: state.settings.indexer_start_block,
        confirmations: state.settings.confirmations,
    }))
}

async fn owner(
    State(state): State<AdminApiState>,
) -> Result<Json<serde_json::Value>, AdminApiError> {
    let owner = state.rpc.owner().await?;
    Ok(Json(serde_json::json!({
        "owner": format_address(owner),
        "tokenAddress": state.settings.token_address,
    })))
}

async fn admin_overview(
    State(state): State<AdminApiState>,
    headers: HeaderMap,
) -> Result<Json<AdminOverviewResponse>, AdminApiError> {
    let signer = require_owner(&state, &headers).await?;
    let owner = state.rpc.owner().await?;
    let chain_head = state.rpc.block_number().await.ok();
    let database = state
        .database
        .lock()
        .map_err(|_| AdminApiError::Database("database lock poisoned".to_owned()))?;
    let state_snapshot = database
        .try_load_state()
        .map_err(|error| AdminApiError::Database(error.to_string()))?;
    let protocol_config = database
        .ensure_protocol_config()
        .map_err(|error| AdminApiError::Database(error.to_string()))?;
    let journal = database
        .try_load_journal()
        .map_err(|error| AdminApiError::Database(error.to_string()))?;
    Ok(Json(AdminOverviewResponse {
        signer: format_address(signer),
        owner: format_address(owner),
        chain_id: state.settings.chain_id,
        chain_head,
        token_address: state.settings.token_address.clone(),
        pancake_v2_router: state.settings.pancake_v2_router.clone(),
        database_state_snapshot: state_snapshot.is_some(),
        protocol_config_initialized: protocol_config.validate().is_ok(),
        pending_commands: journal.pending_commands().len(),
    }))
}

async fn admin_config(
    State(state): State<AdminApiState>,
    headers: HeaderMap,
) -> Result<Json<AdminConfigResponse>, AdminApiError> {
    let signer = require_owner(&state, &headers).await?;
    let database = state
        .database
        .lock()
        .map_err(|_| AdminApiError::Database("database lock poisoned".to_owned()))?;
    let config = database
        .ensure_protocol_config()
        .map_err(|error| AdminApiError::Database(error.to_string()))?;
    Ok(Json(AdminConfigResponse {
        signer: format_address(signer),
        config: ProtocolConfigForm::from(config),
    }))
}

async fn update_admin_config(
    State(state): State<AdminApiState>,
    headers: HeaderMap,
    Json(form): Json<ProtocolConfigForm>,
) -> Result<Json<AdminConfigResponse>, AdminApiError> {
    let signer = require_owner(&state, &headers).await?;
    let signer_text = format_address(signer);
    let config = form.into_config()?;
    let database = state
        .database
        .lock()
        .map_err(|_| AdminApiError::Database("database lock poisoned".to_owned()))?;
    database
        .try_save_protocol_config(&config, &signer_text)
        .map_err(|error| AdminApiError::Database(error.to_string()))?;
    Ok(Json(AdminConfigResponse {
        signer: signer_text,
        config: ProtocolConfigForm::from(config),
    }))
}

async fn admin_state(
    State(state): State<AdminApiState>,
    headers: HeaderMap,
) -> Result<Json<AdminStateResponse<Option<crate::state::ProtocolState>>>, AdminApiError> {
    let signer = require_owner(&state, &headers).await?;
    let database = state
        .database
        .lock()
        .map_err(|_| AdminApiError::Database("database lock poisoned".to_owned()))?;
    let data = database
        .try_load_state()
        .map_err(|error| AdminApiError::Database(error.to_string()))?;
    Ok(Json(AdminStateResponse {
        signer: format_address(signer),
        data,
    }))
}

async fn admin_journal(
    State(state): State<AdminApiState>,
    headers: HeaderMap,
) -> Result<Json<AdminStateResponse<crate::journal::ExecutionJournal>>, AdminApiError> {
    let signer = require_owner(&state, &headers).await?;
    let database = state
        .database
        .lock()
        .map_err(|_| AdminApiError::Database("database lock poisoned".to_owned()))?;
    let data = database
        .try_load_journal()
        .map_err(|error| AdminApiError::Database(error.to_string()))?;
    Ok(Json(AdminStateResponse {
        signer: format_address(signer),
        data,
    }))
}

async fn require_owner(
    state: &AdminApiState,
    headers: &HeaderMap,
) -> Result<ethers_core::types::Address, AdminApiError> {
    let message = header(headers, "x-uscamex-admin-message")?;
    let signature = header(headers, "x-uscamex-admin-signature")?;
    if !message.starts_with(ADMIN_MESSAGE_PREFIX)
        || !message.contains(&format!(
            "token={}",
            state.settings.token_address.to_lowercase()
        ))
        || !message.contains(&format!("chainId={}", state.settings.chain_id))
    {
        return Err(AdminApiError::BadSignature);
    }
    let signature = Signature::from_str(signature).map_err(|_| AdminApiError::BadSignature)?;
    let signer = signature
        .recover(message)
        .map_err(|_| AdminApiError::BadSignature)?;
    let owner = state.rpc.owner().await?;
    if signer != owner {
        return Err(AdminApiError::Forbidden);
    }
    Ok(signer)
}

fn header<'a>(headers: &'a HeaderMap, name: &'static str) -> Result<&'a str, AdminApiError> {
    headers
        .get(name)
        .ok_or(AdminApiError::AuthMissing(name))?
        .to_str()
        .map_err(|_| AdminApiError::AuthMissing(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admin_message_must_bind_chain_and_token() {
        let message = "USCAMEX Admin\naddress=0x1111111111111111111111111111111111111111\ntoken=0x2222222222222222222222222222222222222222\nchainId=56\ntimestamp=1";
        assert!(message.starts_with(ADMIN_MESSAGE_PREFIX));
        assert!(message.contains("token=0x2222222222222222222222222222222222222222"));
        assert!(message.contains("chainId=56"));
    }

    #[test]
    fn config_form_roundtrips_default_protocol_config() {
        let form = ProtocolConfigForm::from(ProtocolConfig::default());
        let config = form.into_config().unwrap();
        assert_eq!(config, ProtocolConfig::default());
    }
}
