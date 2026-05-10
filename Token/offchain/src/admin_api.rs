use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fmt;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::{Arc, Mutex};

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use ethers_core::types::Signature;
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tower_http::cors::CorsLayer;

use crate::config::Wei;
use crate::journal::{CommandStatus, ExecutionJournal};
use crate::rpc::{format_address, BscRpcClient, RpcError};
use crate::settings::OperatorSettings;
use crate::state::{Address, ProtocolState, UserAccount};
use crate::storage::PostgresDatabase;

const ADMIN_MESSAGE_PREFIX: &str = "USCAMEX Admin";
const DEFAULT_TEAM_DEPTH: u32 = 10;
const MAX_TEAM_DEPTH: u32 = 50;
const DEFAULT_PAGE_SIZE: u32 = 50;
const MAX_PAGE_SIZE: u32 = 500;

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
    NotReady(&'static str),
    BadRequest(String),
    NotFound,
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
        let status = match &self {
            Self::AuthMissing(_) | Self::BadSignature => StatusCode::UNAUTHORIZED,
            Self::Forbidden => StatusCode::FORBIDDEN,
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::NotReady(_) => StatusCode::SERVICE_UNAVAILABLE,
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

fn mime_for(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "webp" => "image/webp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "map" => "application/json; charset=utf-8",
        _ => "application/octet-stream",
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
    let app = router_with_static(state);
    let listener = TcpListener::bind(bind_addr).await?;
    println!("operator admin api listening on http://{bind_addr}");
    axum::serve(listener, app).await?;
    Ok(())
}

pub fn router_with_static(state: AdminApiState) -> Router {
    let mut app = router(state);
    let admin_dir =
        std::env::var("USCAMEX_ADMIN_DIR").unwrap_or_else(|_| "../admin/dist".to_string());
    let admin_dir = PathBuf::from(admin_dir);
    if admin_dir.is_dir() {
        let index = admin_dir.join("index.html");
        let admin_dir_for_handler = admin_dir.clone();
        let index_for_handler = index.clone();
        // Single async handler: serve a static asset if the request path maps
        // to an existing file under admin_dir, otherwise fall back to
        // index.html with status 200 so the SPA router can handle deep
        // links like /admin/query/overview.
        let admin_handler = move |path: Option<axum::extract::Path<String>>| {
            let admin_dir = admin_dir_for_handler.clone();
            let index = index_for_handler.clone();
            async move {
                let raw = path.map(|p| p.0).unwrap_or_default();
                let trimmed = raw.trim_start_matches('/');
                let mut target = admin_dir.clone();
                if !trimmed.is_empty() {
                    // Reject path traversal.
                    if trimmed.contains("..") {
                        target = index.clone();
                    } else {
                        target.push(trimmed);
                    }
                }
                let serve_target = if target.is_file() { target } else { index.clone() };
                match tokio::fs::read(&serve_target).await {
                    Ok(bytes) => {
                        let mime = mime_for(&serve_target);
                        (
                            StatusCode::OK,
                            [(axum::http::header::CONTENT_TYPE, mime)],
                            bytes,
                        )
                            .into_response()
                    }
                    Err(error) => (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("admin asset missing: {error}"),
                    )
                        .into_response(),
                }
            }
        };
        println!(
            "operator admin web mounted at /admin from {}",
            admin_dir.display()
        );
        app = app
            .route("/admin", get(admin_handler.clone()))
            .route("/admin/", get(admin_handler.clone()))
            .route("/admin/*path", get(admin_handler));
    } else {
        println!(
            "operator admin web not mounted: directory {} does not exist (set USCAMEX_ADMIN_DIR)",
            admin_dir.display()
        );
    }
    app
}

pub fn router(state: AdminApiState) -> Router {
    Router::new()
        .route("/api/health", get(public_health))
        .route("/api/admin/owner", get(owner))
        .route("/api/admin/overview", get(admin_overview))
        .route("/api/admin/state", get(admin_state))
        .route("/api/admin/journal", get(admin_journal))
        .route("/api/admin/stats", get(admin_stats))
        .route("/api/admin/team", get(admin_team))
        .route("/api/admin/user", get(admin_user))
        .route("/api/admin/users", get(admin_users))
        .route("/api/admin/nodes", get(admin_nodes))
        .route("/api/admin/positions", get(admin_positions))
        .route("/api/admin/journal-list", get(admin_journal_list))
        .route("/api/admin/config-history", get(admin_config_history))
        .route("/api/admin/node-history", get(admin_node_history))
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
    let (has_state_snapshot, pending_commands) = {
        let database = lock_database(&state)?;
        let state_snapshot = database
            .try_load_state()
            .map_err(|error| AdminApiError::Database(error.to_string()))?;
        let journal = database
            .try_load_journal()
            .map_err(|error| AdminApiError::Database(error.to_string()))?;
        (state_snapshot.is_some(), journal.pending_commands().len())
    };
    let protocol_config_initialized = state.rpc.protocol_config().await?.config.validate().is_ok();
    Ok(Json(AdminOverviewResponse {
        signer: format_address(signer),
        owner: format_address(owner),
        chain_id: state.settings.chain_id,
        chain_head,
        token_address: state.settings.token_address.clone(),
        pancake_v2_router: state.settings.pancake_v2_router.clone(),
        database_state_snapshot: has_state_snapshot,
        protocol_config_initialized,
        pending_commands,
    }))
}

async fn admin_state(
    State(state): State<AdminApiState>,
    headers: HeaderMap,
) -> Result<Json<AdminStateResponse<Option<ProtocolState>>>, AdminApiError> {
    let signer = require_owner(&state, &headers).await?;
    let database = lock_database(&state)?;
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
) -> Result<Json<AdminStateResponse<ExecutionJournal>>, AdminApiError> {
    let signer = require_owner(&state, &headers).await?;
    let database = lock_database(&state)?;
    let data = database
        .try_load_journal()
        .map_err(|error| AdminApiError::Database(error.to_string()))?;
    Ok(Json(AdminStateResponse {
        signer: format_address(signer),
        data,
    }))
}

#[derive(Debug, Serialize)]
struct GlobalStatsResponse {
    signer: String,
    chain_id: u64,
    chain_head: Option<u64>,
    token_address: String,
    root: Option<String>,
    current_day: u64,
    deflation_used_bps: u16,
    total_users: usize,
    bound_users: usize,
    active_users: usize,
    exited_users: usize,
    nodes_count: usize,
    total_principal_bnb: String,
    total_static_paid_bnb: String,
    total_dynamic_paid_bnb: String,
    burned_tokens: String,
    tax_burned_token_value_bnb: String,
    vault_bnb: String,
    owner_bnb: String,
    builder_token_value_bnb: String,
    builder_token_amount: String,
    pair_token_reserve: String,
    pair_bnb_reserve: String,
    last_indexed_block: Option<u64>,
    processed_events: usize,
    processed_settlements: usize,
    pending_commands: usize,
    submitted_commands: usize,
    confirmed_commands: usize,
    failed_commands: usize,
    protocol_config_initialized: bool,
}

async fn admin_stats(
    State(state): State<AdminApiState>,
    headers: HeaderMap,
) -> Result<Json<GlobalStatsResponse>, AdminApiError> {
    let signer = require_owner(&state, &headers).await?;
    let chain_head = state.rpc.block_number().await.ok();
    let protocol_config_initialized = state.rpc.protocol_config().await?.config.validate().is_ok();

    let (snapshot, journal, last_block) = {
        let database = lock_database(&state)?;
        let snapshot = database
            .try_load_state()
            .map_err(|error| AdminApiError::Database(error.to_string()))?;
        let journal = database
            .try_load_journal()
            .map_err(|error| AdminApiError::Database(error.to_string()))?;
        let last_block = database
            .try_last_indexed_block()
            .map_err(|error| AdminApiError::Database(error.to_string()))?;
        (snapshot, journal, last_block)
    };

    let mut response = GlobalStatsResponse {
        signer: format_address(signer),
        chain_id: state.settings.chain_id,
        chain_head,
        token_address: state.settings.token_address.clone(),
        root: None,
        current_day: 0,
        deflation_used_bps: 0,
        total_users: 0,
        bound_users: 0,
        active_users: 0,
        exited_users: 0,
        nodes_count: 0,
        total_principal_bnb: "0".to_string(),
        total_static_paid_bnb: "0".to_string(),
        total_dynamic_paid_bnb: "0".to_string(),
        burned_tokens: "0".to_string(),
        tax_burned_token_value_bnb: "0".to_string(),
        vault_bnb: "0".to_string(),
        owner_bnb: "0".to_string(),
        builder_token_value_bnb: "0".to_string(),
        builder_token_amount: "0".to_string(),
        pair_token_reserve: "0".to_string(),
        pair_bnb_reserve: "0".to_string(),
        last_indexed_block: last_block.map(|block| block.number),
        processed_events: 0,
        processed_settlements: 0,
        pending_commands: count_status(&journal, |status| matches!(status, CommandStatus::Pending)),
        submitted_commands: count_status(&journal, |status| {
            matches!(status, CommandStatus::Submitted { .. })
        }),
        confirmed_commands: count_status(&journal, |status| {
            matches!(status, CommandStatus::Confirmed { .. })
        }),
        failed_commands: count_status(&journal, |status| {
            matches!(status, CommandStatus::Failed { .. })
        }),
        protocol_config_initialized,
    };

    if let Some(snapshot) = snapshot.as_ref() {
        let mut total_principal: Wei = 0;
        let mut total_static: Wei = 0;
        let mut total_dynamic: Wei = 0;
        let mut active = 0usize;
        let mut exited = 0usize;
        let mut bound = 0usize;
        for (address, user) in &snapshot.users {
            total_principal = total_principal.saturating_add(user.principal_bnb);
            total_static = total_static.saturating_add(user.static_paid_bnb);
            total_dynamic = total_dynamic.saturating_add(user.dynamic_paid_bnb);
            if user.active {
                active += 1;
            }
            if user.exited {
                exited += 1;
            }
            if user
                .referrer
                .as_ref()
                .is_some_and(|referrer| referrer != address)
            {
                bound += 1;
            }
        }
        response.root = Some(snapshot.root.clone());
        response.current_day = snapshot.current_day;
        response.deflation_used_bps = snapshot.deflation_used_bps;
        response.total_users = snapshot.users.len();
        response.bound_users = bound;
        response.active_users = active;
        response.exited_users = exited;
        response.nodes_count = snapshot.nodes.len();
        response.total_principal_bnb = total_principal.to_string();
        response.total_static_paid_bnb = total_static.to_string();
        response.total_dynamic_paid_bnb = total_dynamic.to_string();
        response.burned_tokens = snapshot.balances.burned_tokens.to_string();
        response.tax_burned_token_value_bnb =
            snapshot.balances.tax_burned_token_value_bnb.to_string();
        response.vault_bnb = snapshot.balances.vault_bnb.to_string();
        response.owner_bnb = snapshot.balances.owner_bnb.to_string();
        response.builder_token_value_bnb = snapshot.balances.builder_token_value_bnb.to_string();
        response.builder_token_amount = snapshot.balances.builder_token_amount.to_string();
        response.pair_token_reserve = snapshot.pair.token_reserve.to_string();
        response.pair_bnb_reserve = snapshot.pair.bnb_reserve.to_string();
        response.processed_events = snapshot.processed_events.len();
        response.processed_settlements = snapshot.processed_settlements.len();
    }
    Ok(Json(response))
}

#[derive(Debug, Deserialize)]
struct AddressQuery {
    address: String,
}

#[derive(Debug, Deserialize)]
struct TeamQuery {
    address: String,
    depth: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct PageQuery {
    limit: Option<u32>,
    offset: Option<u32>,
    sort: Option<String>,
    filter: Option<String>,
}

#[derive(Debug, Deserialize)]
struct JournalListQuery {
    status: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct HistoryQuery {
    limit: Option<u32>,
}

#[derive(Debug, Serialize)]
struct UserSummary {
    address: String,
    referrer: Option<String>,
    direct_count: u32,
    position_id: u64,
    principal_bnb: String,
    static_paid_bnb: String,
    dynamic_paid_bnb: String,
    active: bool,
    exited: bool,
    is_node: bool,
    node_weight: Option<u32>,
    node_paid_bnb: String,
    direct_paid_bnb: String,
}

#[derive(Debug, Serialize)]
struct GenerationGroup {
    generation: u32,
    count: usize,
    members: Vec<UserSummary>,
}

#[derive(Debug, Serialize)]
struct TeamResponse {
    signer: String,
    root: UserSummary,
    direct_members: Vec<UserSummary>,
    generations: Vec<GenerationGroup>,
    total_descendants: usize,
    truncated_at_depth: u32,
}

async fn admin_team(
    State(state): State<AdminApiState>,
    headers: HeaderMap,
    Query(query): Query<TeamQuery>,
) -> Result<Json<TeamResponse>, AdminApiError> {
    let signer = require_owner(&state, &headers).await?;
    let depth = query
        .depth
        .unwrap_or(DEFAULT_TEAM_DEPTH)
        .clamp(1, MAX_TEAM_DEPTH);
    let address = normalize_address(&query.address)?;
    let snapshot = require_state(&state)?;
    if !snapshot.users.contains_key(&address) {
        return Err(AdminApiError::NotFound);
    }
    let nodes = node_index(&snapshot);
    let children = build_child_index(&snapshot);
    let root = build_user_summary(&snapshot, &nodes, &address);
    let direct_members = children
        .get(&address)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|child| build_user_summary(&snapshot, &nodes, &child))
        .collect::<Vec<_>>();

    let mut generations: Vec<GenerationGroup> = Vec::new();
    let mut visited: BTreeSet<String> = BTreeSet::from([address.clone()]);
    let mut frontier: VecDeque<(String, u32)> = VecDeque::new();
    if let Some(direct) = children.get(&address) {
        for child in direct {
            if visited.insert(child.clone()) {
                frontier.push_back((child.clone(), 1));
            }
        }
    }
    let mut total_descendants = 0usize;
    while let Some((current, generation)) = frontier.pop_front() {
        if generation > depth {
            continue;
        }
        let summary = build_user_summary(&snapshot, &nodes, &current);
        match generations
            .iter_mut()
            .find(|group| group.generation == generation)
        {
            Some(group) => {
                group.members.push(summary);
                group.count += 1;
            }
            None => {
                generations.push(GenerationGroup {
                    generation,
                    count: 1,
                    members: vec![summary],
                });
            }
        }
        total_descendants += 1;
        if generation < depth {
            if let Some(next_children) = children.get(&current) {
                for child in next_children {
                    if visited.insert(child.clone()) {
                        frontier.push_back((child.clone(), generation + 1));
                    }
                }
            }
        }
    }
    generations.sort_by_key(|group| group.generation);
    Ok(Json(TeamResponse {
        signer: format_address(signer),
        root,
        direct_members,
        generations,
        total_descendants,
        truncated_at_depth: depth,
    }))
}

#[derive(Debug, Serialize)]
struct UserDetailResponse {
    signer: String,
    summary: UserSummary,
    referrer_summary: Option<UserSummary>,
    direct_members: Vec<UserSummary>,
}

async fn admin_user(
    State(state): State<AdminApiState>,
    headers: HeaderMap,
    Query(query): Query<AddressQuery>,
) -> Result<Json<UserDetailResponse>, AdminApiError> {
    let signer = require_owner(&state, &headers).await?;
    let address = normalize_address(&query.address)?;
    let snapshot = require_state(&state)?;
    if !snapshot.users.contains_key(&address) {
        return Err(AdminApiError::NotFound);
    }
    let nodes = node_index(&snapshot);
    let children = build_child_index(&snapshot);
    let summary = build_user_summary(&snapshot, &nodes, &address);
    let referrer_summary = snapshot
        .users
        .get(&address)
        .and_then(|user| user.referrer.clone())
        .filter(|referrer| referrer != &address)
        .map(|referrer| build_user_summary(&snapshot, &nodes, &referrer));
    let direct_members = children
        .get(&address)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|child| build_user_summary(&snapshot, &nodes, &child))
        .collect();
    Ok(Json(UserDetailResponse {
        signer: format_address(signer),
        summary,
        referrer_summary,
        direct_members,
    }))
}

#[derive(Debug, Serialize)]
struct UsersListResponse {
    signer: String,
    total: usize,
    limit: u32,
    offset: u32,
    items: Vec<UserSummary>,
}

async fn admin_users(
    State(state): State<AdminApiState>,
    headers: HeaderMap,
    Query(query): Query<PageQuery>,
) -> Result<Json<UsersListResponse>, AdminApiError> {
    let signer = require_owner(&state, &headers).await?;
    let limit = query
        .limit
        .unwrap_or(DEFAULT_PAGE_SIZE)
        .clamp(1, MAX_PAGE_SIZE);
    let offset = query.offset.unwrap_or(0);
    let filter = query.filter.unwrap_or_default().to_lowercase();
    let sort = query.sort.unwrap_or_else(|| "principal-desc".to_string());
    let snapshot = require_state(&state)?;
    let nodes = node_index(&snapshot);
    let mut items: Vec<UserSummary> = snapshot
        .users
        .keys()
        .filter(|address| filter.is_empty() || address.contains(&filter))
        .map(|address| build_user_summary(&snapshot, &nodes, address))
        .collect();
    match sort.as_str() {
        "principal-asc" => items.sort_by_key(|user| parse_wei(&user.principal_bnb)),
        "static-desc" => {
            items.sort_by_key(|user| std::cmp::Reverse(parse_wei(&user.static_paid_bnb)))
        }
        "dynamic-desc" => {
            items.sort_by_key(|user| std::cmp::Reverse(parse_wei(&user.dynamic_paid_bnb)))
        }
        "direct-desc" => items.sort_by_key(|user| std::cmp::Reverse(user.direct_count)),
        "address-asc" => items.sort_by(|a, b| a.address.cmp(&b.address)),
        _ => items.sort_by_key(|user| std::cmp::Reverse(parse_wei(&user.principal_bnb))),
    };
    let total = items.len();
    let page: Vec<UserSummary> = items
        .into_iter()
        .skip(offset as usize)
        .take(limit as usize)
        .collect();
    Ok(Json(UsersListResponse {
        signer: format_address(signer),
        total,
        limit,
        offset,
        items: page,
    }))
}

#[derive(Debug, Serialize)]
struct NodeSummary {
    address: String,
    weight: u32,
    paid_bnb: String,
}

#[derive(Debug, Serialize)]
struct NodesResponse {
    signer: String,
    items: Vec<NodeSummary>,
    total_paid_bnb: String,
}

async fn admin_nodes(
    State(state): State<AdminApiState>,
    headers: HeaderMap,
) -> Result<Json<NodesResponse>, AdminApiError> {
    let signer = require_owner(&state, &headers).await?;
    let snapshot = require_state(&state)?;
    let mut total: Wei = 0;
    let items: Vec<NodeSummary> = snapshot
        .nodes
        .iter()
        .map(|node| {
            let paid = snapshot
                .balances
                .node_paid_bnb
                .get(&node.address)
                .copied()
                .unwrap_or(0);
            total = total.saturating_add(paid);
            NodeSummary {
                address: node.address.clone(),
                weight: node.weight,
                paid_bnb: paid.to_string(),
            }
        })
        .collect();
    Ok(Json(NodesResponse {
        signer: format_address(signer),
        items,
        total_paid_bnb: total.to_string(),
    }))
}

#[derive(Debug, Serialize)]
struct PositionItem {
    user: String,
    position_id: u64,
    principal_bnb: String,
    static_paid_bnb: String,
    dynamic_paid_bnb: String,
    active: bool,
    exited: bool,
}

#[derive(Debug, Serialize)]
struct PositionsResponse {
    signer: String,
    total: usize,
    limit: u32,
    offset: u32,
    items: Vec<PositionItem>,
}

async fn admin_positions(
    State(state): State<AdminApiState>,
    headers: HeaderMap,
    Query(query): Query<PageQuery>,
) -> Result<Json<PositionsResponse>, AdminApiError> {
    let signer = require_owner(&state, &headers).await?;
    let limit = query
        .limit
        .unwrap_or(DEFAULT_PAGE_SIZE)
        .clamp(1, MAX_PAGE_SIZE);
    let offset = query.offset.unwrap_or(0);
    let filter = query.filter.unwrap_or_default().to_lowercase();
    let sort = query.sort.unwrap_or_else(|| "position-desc".to_string());
    let snapshot = require_state(&state)?;
    let mut items: Vec<PositionItem> = snapshot
        .users
        .iter()
        .filter(|(_, user)| user.position_id != 0 || user.principal_bnb != 0)
        .filter(|(address, _)| filter.is_empty() || address.contains(&filter))
        .map(|(address, user)| PositionItem {
            user: address.clone(),
            position_id: user.position_id,
            principal_bnb: user.principal_bnb.to_string(),
            static_paid_bnb: user.static_paid_bnb.to_string(),
            dynamic_paid_bnb: user.dynamic_paid_bnb.to_string(),
            active: user.active,
            exited: user.exited,
        })
        .collect();
    match sort.as_str() {
        "principal-desc" => {
            items.sort_by_key(|item| std::cmp::Reverse(parse_wei(&item.principal_bnb)))
        }
        "principal-asc" => items.sort_by_key(|item| parse_wei(&item.principal_bnb)),
        _ => items.sort_by_key(|item| std::cmp::Reverse(item.position_id)),
    };
    let total = items.len();
    let page: Vec<PositionItem> = items
        .into_iter()
        .skip(offset as usize)
        .take(limit as usize)
        .collect();
    Ok(Json(PositionsResponse {
        signer: format_address(signer),
        total,
        limit,
        offset,
        items: page,
    }))
}

#[derive(Debug, Serialize)]
struct JournalEntry {
    id: String,
    kind: String,
    status: String,
    tx_hash: Option<String>,
    error: Option<String>,
    attempts: u32,
    payload: serde_json::Value,
}

#[derive(Debug, Serialize)]
struct JournalListResponse {
    signer: String,
    total: usize,
    limit: u32,
    offset: u32,
    items: Vec<JournalEntry>,
    counts: JournalCounts,
}

#[derive(Debug, Serialize)]
struct JournalCounts {
    pending: usize,
    submitted: usize,
    confirmed: usize,
    failed: usize,
}

async fn admin_journal_list(
    State(state): State<AdminApiState>,
    headers: HeaderMap,
    Query(query): Query<JournalListQuery>,
) -> Result<Json<JournalListResponse>, AdminApiError> {
    let signer = require_owner(&state, &headers).await?;
    let limit = query
        .limit
        .unwrap_or(DEFAULT_PAGE_SIZE)
        .clamp(1, MAX_PAGE_SIZE);
    let offset = query.offset.unwrap_or(0);
    let status_filter = query.status.unwrap_or_default().to_lowercase();
    let journal = {
        let database = lock_database(&state)?;
        database
            .try_load_journal()
            .map_err(|error| AdminApiError::Database(error.to_string()))?
    };
    let counts = JournalCounts {
        pending: count_status(&journal, |status| matches!(status, CommandStatus::Pending)),
        submitted: count_status(&journal, |status| {
            matches!(status, CommandStatus::Submitted { .. })
        }),
        confirmed: count_status(&journal, |status| {
            matches!(status, CommandStatus::Confirmed { .. })
        }),
        failed: count_status(&journal, |status| {
            matches!(status, CommandStatus::Failed { .. })
        }),
    };
    let mut items: Vec<JournalEntry> = journal
        .records
        .into_values()
        .filter(|record| match status_filter.as_str() {
            "pending" => matches!(record.status, CommandStatus::Pending),
            "submitted" => matches!(record.status, CommandStatus::Submitted { .. }),
            "confirmed" => matches!(record.status, CommandStatus::Confirmed { .. }),
            "failed" => matches!(record.status, CommandStatus::Failed { .. }),
            _ => true,
        })
        .map(|record| {
            let (status_label, tx_hash, error) = match &record.status {
                CommandStatus::Pending => ("pending".to_string(), None, None),
                CommandStatus::Submitted { tx_hash } => {
                    ("submitted".to_string(), Some(tx_hash.clone()), None)
                }
                CommandStatus::Confirmed { tx_hash } => {
                    ("confirmed".to_string(), Some(tx_hash.clone()), None)
                }
                CommandStatus::Failed { error } => {
                    ("failed".to_string(), None, Some(error.clone()))
                }
            };
            JournalEntry {
                id: record.id,
                kind: record.command.kind().to_string(),
                status: status_label,
                tx_hash,
                error,
                attempts: record.attempts,
                payload: serde_json::to_value(&record.command).unwrap_or(serde_json::Value::Null),
            }
        })
        .collect();
    items.sort_by(|a, b| b.id.cmp(&a.id));
    let total = items.len();
    let page: Vec<JournalEntry> = items
        .into_iter()
        .skip(offset as usize)
        .take(limit as usize)
        .collect();
    Ok(Json(JournalListResponse {
        signer: format_address(signer),
        total,
        limit,
        offset,
        items: page,
        counts,
    }))
}

#[derive(Debug, Serialize)]
struct ConfigHistoryResponse {
    signer: String,
    items: Vec<crate::storage::ConfigHistoryEntry>,
}

async fn admin_config_history(
    State(state): State<AdminApiState>,
    headers: HeaderMap,
    Query(query): Query<HistoryQuery>,
) -> Result<Json<ConfigHistoryResponse>, AdminApiError> {
    let signer = require_owner(&state, &headers).await?;
    let limit = query.limit.unwrap_or(20).clamp(1, 200) as i64;
    let database = lock_database(&state)?;
    let items = database
        .try_load_protocol_config_history(limit)
        .map_err(|error| AdminApiError::Database(error.to_string()))?;
    Ok(Json(ConfigHistoryResponse {
        signer: format_address(signer),
        items,
    }))
}

#[derive(Debug, Serialize)]
struct NodeHistoryResponse {
    signer: String,
    items: Vec<crate::storage::NodeHistoryEntry>,
}

async fn admin_node_history(
    State(state): State<AdminApiState>,
    headers: HeaderMap,
    Query(query): Query<HistoryQuery>,
) -> Result<Json<NodeHistoryResponse>, AdminApiError> {
    let signer = require_owner(&state, &headers).await?;
    let limit = query.limit.unwrap_or(50).clamp(1, 500) as i64;
    let database = lock_database(&state)?;
    let items = database
        .try_load_node_history(limit)
        .map_err(|error| AdminApiError::Database(error.to_string()))?;
    Ok(Json(NodeHistoryResponse {
        signer: format_address(signer),
        items,
    }))
}

fn lock_database(
    state: &AdminApiState,
) -> Result<std::sync::MutexGuard<'_, PostgresDatabase>, AdminApiError> {
    state
        .database
        .lock()
        .map_err(|_| AdminApiError::Database("database lock poisoned".to_owned()))
}

fn require_state(state: &AdminApiState) -> Result<ProtocolState, AdminApiError> {
    let database = lock_database(state)?;
    let snapshot = database
        .try_load_state()
        .map_err(|error| AdminApiError::Database(error.to_string()))?;
    snapshot.ok_or(AdminApiError::NotReady("protocol state not initialized"))
}

fn build_child_index(state: &ProtocolState) -> BTreeMap<Address, Vec<Address>> {
    let mut index: BTreeMap<Address, Vec<Address>> = BTreeMap::new();
    for (address, user) in &state.users {
        if let Some(referrer) = user.referrer.as_ref() {
            if referrer != address {
                index
                    .entry(referrer.clone())
                    .or_default()
                    .push(address.clone());
            }
        }
    }
    for children in index.values_mut() {
        children.sort();
    }
    index
}

fn node_index(state: &ProtocolState) -> BTreeMap<Address, u32> {
    state
        .nodes
        .iter()
        .map(|node| (node.address.clone(), node.weight))
        .collect()
}

fn build_user_summary(
    state: &ProtocolState,
    nodes: &BTreeMap<Address, u32>,
    address: &str,
) -> UserSummary {
    let user = state
        .users
        .get(address)
        .cloned()
        .unwrap_or_else(UserAccount::default);
    let node_paid = state
        .balances
        .node_paid_bnb
        .get(address)
        .copied()
        .unwrap_or(0);
    let direct_paid = state
        .balances
        .direct_paid_bnb
        .get(address)
        .copied()
        .unwrap_or(0);
    let weight = nodes.get(address).copied();
    UserSummary {
        address: address.to_string(),
        referrer: user.referrer.filter(|referrer| referrer != address),
        direct_count: user.direct_count,
        position_id: user.position_id,
        principal_bnb: user.principal_bnb.to_string(),
        static_paid_bnb: user.static_paid_bnb.to_string(),
        dynamic_paid_bnb: user.dynamic_paid_bnb.to_string(),
        active: user.active,
        exited: user.exited,
        is_node: weight.is_some(),
        node_weight: weight,
        node_paid_bnb: node_paid.to_string(),
        direct_paid_bnb: direct_paid.to_string(),
    }
}

fn count_status(journal: &ExecutionJournal, predicate: impl Fn(&CommandStatus) -> bool) -> usize {
    journal
        .records
        .values()
        .filter(|record| predicate(&record.status))
        .count()
}

fn parse_wei(value: &str) -> Wei {
    value.parse::<Wei>().unwrap_or(0)
}

fn normalize_address(value: &str) -> Result<String, AdminApiError> {
    let trimmed = value.trim();
    if trimmed.len() != 42 || !trimmed.starts_with("0x") {
        return Err(AdminApiError::BadRequest(format!(
            "invalid address: {value}"
        )));
    }
    if !trimmed
        .chars()
        .skip(2)
        .all(|character| character.is_ascii_hexdigit())
    {
        return Err(AdminApiError::BadRequest(format!(
            "invalid address: {value}"
        )));
    }
    Ok(trimmed.to_ascii_lowercase())
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
    use crate::config::BNB;
    use crate::state::Node;

    #[test]
    fn admin_message_must_bind_chain_and_token() {
        let message = "USCAMEX Admin\naddress=0x1111111111111111111111111111111111111111\ntoken=0x2222222222222222222222222222222222222222\nchainId=56\ntimestamp=1";
        assert!(message.starts_with(ADMIN_MESSAGE_PREFIX));
        assert!(message.contains("token=0x2222222222222222222222222222222222222222"));
        assert!(message.contains("chainId=56"));
    }

    #[test]
    fn build_child_index_groups_by_referrer() {
        let mut state = ProtocolState::new("root");
        state.ensure_user_mut("alice").referrer = Some("root".to_string());
        state.ensure_user_mut("bob").referrer = Some("root".to_string());
        state.ensure_user_mut("carol").referrer = Some("alice".to_string());
        let index = build_child_index(&state);
        assert_eq!(index.get("root").unwrap().len(), 2);
        assert_eq!(index.get("alice").unwrap(), &vec!["carol".to_string()]);
        assert!(!index.contains_key("carol"));
    }

    #[test]
    fn build_user_summary_includes_node_and_direct_payouts() {
        let mut state = ProtocolState::new("root");
        state.ensure_user_mut("alice").principal_bnb = BNB;
        state.ensure_user_mut("alice").direct_count = 3;
        state.ensure_user_mut("alice").referrer = Some("root".to_string());
        state.nodes.push(Node {
            address: "alice".to_string(),
            weight: 100,
        });
        state
            .balances
            .node_paid_bnb
            .insert("alice".to_string(), 2 * BNB);
        state
            .balances
            .direct_paid_bnb
            .insert("alice".to_string(), BNB / 4);
        let nodes = node_index(&state);
        let summary = build_user_summary(&state, &nodes, "alice");
        assert_eq!(summary.direct_count, 3);
        assert_eq!(summary.principal_bnb, BNB.to_string());
        assert_eq!(summary.node_paid_bnb, (2 * BNB).to_string());
        assert_eq!(summary.direct_paid_bnb, (BNB / 4).to_string());
        assert!(summary.is_node);
        assert_eq!(summary.node_weight, Some(100));
    }

    #[test]
    fn normalize_address_rejects_bad_input() {
        assert!(normalize_address("not-an-address").is_err());
        assert!(normalize_address("0x1234").is_err());
        assert_eq!(
            normalize_address("0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").unwrap(),
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );
    }
}
