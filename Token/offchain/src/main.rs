use std::time::Duration;

use uscamex_operator::admin_api::serve_admin_api;
use uscamex_operator::chain::{BscTransactionClient, ChainExecutionContext};
use uscamex_operator::engine::Engine;
use uscamex_operator::rpc::{format_address, BscRpcClient};
use uscamex_operator::runtime::{OperatorRuntime, RuntimeScanConfig};
use uscamex_operator::service::OperatorService;
use uscamex_operator::settings::OperatorSettings;
use uscamex_operator::storage::PostgresDatabase;
use uscamex_operator::ws::{spawn_ws_listener, WsRpcConfig, WsRuntimeState};

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let settings = OperatorSettings::from_env()?;
    let admin_database = PostgresDatabase::connect(&settings.database_url)?;
    admin_database.run_migrations()?;

    let runtime_rpc = BscRpcClient::new(&settings.bsc_rpc_url, &settings.token_address)?;
    let chain_config = runtime_rpc.protocol_config().await?;
    admin_database.try_save_protocol_config(&chain_config.config, "chain")?;
    let owner = format_address(runtime_rpc.owner().await?);
    let vault = format_address(runtime_rpc.vault().await?);
    let runtime_database = PostgresDatabase::connect(&settings.database_url)?;
    let chain = BscTransactionClient::new(
        &settings.bsc_rpc_url,
        settings.chain_id,
        &settings.operator_private_key,
        ChainExecutionContext {
            token_address: settings.token_address.clone(),
            vault_address: vault.clone(),
            router_address: settings.pancake_v2_router.clone(),
            owner_address: owner.clone(),
            burn_address: settings.burn_address.clone(),
            slippage_bps: settings.executor_slippage_bps,
            deadline_seconds: settings.transaction_deadline_seconds,
        },
        settings.confirmations,
    )?;
    let mut initial_config = chain_config.config;
    if !chain_config.buy_enabled {
        initial_config.buyback_enabled = false;
    }
    let service = OperatorService::restore_or_new(
        Engine::new(initial_config),
        runtime_database,
        chain,
        owner.clone(),
    );
    let mut scan_config =
        RuntimeScanConfig::new(settings.indexer_start_block, settings.confirmations);
    scan_config.max_blocks_per_scan = settings.rpc_max_blocks_per_scan;
    scan_config.poll_interval = Duration::from_secs(settings.rpc_scan_poll_secs);
    scan_config.protocol_config_interval = Duration::from_secs(settings.rpc_config_ttl_secs);
    scan_config.nodes_interval = Duration::from_secs(settings.rpc_nodes_ttl_secs);
    scan_config.pair_reserves_interval = Duration::from_secs(settings.rpc_reserves_ttl_secs);
    scan_config.vault_balance_interval = Duration::from_secs(settings.rpc_vault_balance_ttl_secs);
    scan_config.failure_backoff_max = Duration::from_secs(settings.rpc_failure_backoff_max_secs);
    scan_config.ws_stale_after = Duration::from_secs(settings.ws_stale_secs);
    scan_config.ws_gap_scan_blocks = settings.ws_gap_scan_blocks;
    scan_config.ws_reconcile_interval = Duration::from_secs(settings.ws_reconcile_interval_secs);
    let ws_state = if settings.ws_enabled {
        let ws_url = settings
            .bsc_ws_rpc_url
            .clone()
            .expect("WS_ENABLED requires BSC_WS_RPC_URL after settings validation");
        let state = WsRuntimeState::default();
        let config = WsRpcConfig {
            url: ws_url,
            token_address: settings.token_address.clone(),
            reconnect_min: Duration::from_secs(settings.ws_reconnect_min_secs),
            reconnect_max: Duration::from_secs(settings.ws_reconnect_max_secs),
            stale_after: Duration::from_secs(settings.ws_stale_secs),
        };
        spawn_ws_listener(config, state.clone());
        Some(state)
    } else {
        None
    };
    let mut runtime = OperatorRuntime::new(service, runtime_rpc, scan_config);
    if let Some(state) = ws_state {
        runtime = runtime.with_ws_state(state);
    }

    println!(
        "operator ready: chain_id={} token={} router={} owner={} vault={} config_operator={} buy_enabled={} start_block={} confirmations={} ws_enabled={}",
        settings.chain_id,
        settings.token_address,
        settings.pancake_v2_router,
        owner,
        vault,
        chain_config.operator,
        chain_config.buy_enabled,
        settings.indexer_start_block,
        settings.confirmations,
        settings.ws_enabled
    );
    tokio::select! {
        result = runtime.run_forever() => result.map_err(|error| -> Box<dyn std::error::Error> { Box::new(error) })?,
        result = serve_admin_api(settings, admin_database) => result.map_err(|error| -> Box<dyn std::error::Error> { Box::new(error) })?,
    }
    Ok(())
}
