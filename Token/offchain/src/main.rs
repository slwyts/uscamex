use uscamex_operator::admin_api::serve_admin_api;
use uscamex_operator::settings::OperatorSettings;
use uscamex_operator::storage::PostgresDatabase;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let settings = OperatorSettings::from_env()?;
    let database = PostgresDatabase::connect(&settings.database_url)?;
    database.run_migrations()?;
    database.ensure_protocol_config()?;

    println!(
        "operator ready: chain_id={} token={} router={} start_block={} confirmations={}",
        settings.chain_id,
        settings.token_address,
        settings.pancake_v2_router,
        settings.indexer_start_block,
        settings.confirmations
    );
    serve_admin_api(settings, database).await?;
    Ok(())
}
