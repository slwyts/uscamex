use uscamex_operator::admin_api::serve_admin_api;
use uscamex_operator::chain::{BscTransactionClient, ChainExecutionContext};
use uscamex_operator::engine::Engine;
use uscamex_operator::rpc::{format_address, BscRpcClient};
use uscamex_operator::runtime::{OperatorRuntime, RuntimeScanConfig};
use uscamex_operator::service::OperatorService;
use uscamex_operator::settings::OperatorSettings;
use uscamex_operator::storage::PostgresDatabase;

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
    let scan_config = RuntimeScanConfig::new(settings.indexer_start_block, settings.confirmations);
    let mut runtime = OperatorRuntime::new(service, runtime_rpc, scan_config);

    println!(
        "operator ready: chain_id={} token={} router={} owner={} vault={} config_operator={} buy_enabled={} start_block={} confirmations={}",
        settings.chain_id,
        settings.token_address,
        settings.pancake_v2_router,
        owner,
        vault,
        chain_config.operator,
        chain_config.buy_enabled,
        settings.indexer_start_block,
        settings.confirmations
    );
    tokio::select! {
        result = runtime.run_forever() => result.map_err(|error| -> Box<dyn std::error::Error> { Box::new(error) })?,
        result = serve_admin_api(settings, admin_database) => result.map_err(|error| -> Box<dyn std::error::Error> { Box::new(error) })?,
    }
    Ok(())
}
