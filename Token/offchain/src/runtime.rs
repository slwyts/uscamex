use std::fmt;
use std::time::Duration;

use crate::chain::ChainClient;
use crate::indexer::{decode_protocol_log, DecodeError, RawLog};
use crate::rpc::{BscRpcClient, RpcError};
use crate::service::{EventOutcome, OperatorService, ServiceError};
use crate::storage::{OperatorDatabase, StoredBlock};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeScanConfig {
    pub start_block: u64,
    pub confirmations: u64,
    pub max_blocks_per_scan: u64,
    pub poll_interval: Duration,
}

impl RuntimeScanConfig {
    pub fn new(start_block: u64, confirmations: u64) -> Self {
        Self {
            start_block,
            confirmations: confirmations.max(1),
            max_blocks_per_scan: 1_000,
            poll_interval: Duration::from_secs(5),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RuntimeScanSummary {
    pub from_block: u64,
    pub to_block: u64,
    pub synced_pair_reserves: bool,
    pub raw_logs: usize,
    pub decoded_events: usize,
    pub applied_events: usize,
    pub duplicate_events: usize,
    pub planned_commands: usize,
    pub submitted_transactions: Vec<String>,
}

#[derive(Debug)]
pub enum RuntimeError<ChainError> {
    Rpc(RpcError),
    Decode(DecodeError),
    Service(ServiceError<ChainError>),
    ReorgDetected {
        block_number: u64,
        expected_hash: String,
        observed_hash: String,
    },
}

impl<ChainError: fmt::Debug> fmt::Display for RuntimeError<ChainError> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl<ChainError: fmt::Debug> std::error::Error for RuntimeError<ChainError> {}

pub struct OperatorRuntime<D, C> {
    pub service: OperatorService<D, C>,
    pub rpc: BscRpcClient,
    pub config: RuntimeScanConfig,
}

impl<D, C> OperatorRuntime<D, C>
where
    D: OperatorDatabase,
    C: ChainClient,
    C::Error: fmt::Debug,
{
    pub fn new(
        service: OperatorService<D, C>,
        rpc: BscRpcClient,
        config: RuntimeScanConfig,
    ) -> Self {
        Self {
            service,
            rpc,
            config,
        }
    }

    pub async fn run_once(&mut self) -> Result<Option<RuntimeScanSummary>, RuntimeError<C::Error>> {
        scan_confirmed_logs_once(&mut self.service, &self.rpc, &self.config).await
    }

    pub async fn run_forever(&mut self) -> Result<(), RuntimeError<C::Error>> {
        loop {
            match self.run_once().await? {
                Some(summary)
                    if summary.raw_logs != 0 || !summary.submitted_transactions.is_empty() =>
                {
                    println!(
                        "operator tick: blocks={}..{} logs={} applied={} planned={} submitted={}",
                        summary.from_block,
                        summary.to_block,
                        summary.raw_logs,
                        summary.applied_events,
                        summary.planned_commands,
                        summary.submitted_transactions.len()
                    );
                }
                _ => {}
            }
            tokio::time::sleep(self.config.poll_interval).await;
        }
    }
}

pub async fn scan_confirmed_logs_once<D, C>(
    service: &mut OperatorService<D, C>,
    rpc: &BscRpcClient,
    config: &RuntimeScanConfig,
) -> Result<Option<RuntimeScanSummary>, RuntimeError<C::Error>>
where
    D: OperatorDatabase,
    C: ChainClient,
    C::Error: fmt::Debug,
{
    let chain_head = rpc.block_number().await.map_err(RuntimeError::Rpc)?;
    let Some(safe_head) = chain_head.checked_sub(config.confirmations) else {
        return Ok(None);
    };
    let from_block = service
        .database
        .last_indexed_block()
        .map(|block| block.number.saturating_add(1))
        .unwrap_or(config.start_block);
    if from_block > safe_head {
        return Ok(None);
    }
    let synced_pair_reserves = sync_pair_reserves(service, rpc).await?;
    let to_block = from_block
        .saturating_add(config.max_blocks_per_scan.saturating_sub(1))
        .min(safe_head);
    let to_hash = rpc.block_hash(to_block).await.map_err(RuntimeError::Rpc)?;
    if let Some(previous) = service.database.last_indexed_block() {
        if previous.number == to_block && previous.hash != to_hash {
            return Err(RuntimeError::ReorgDetected {
                block_number: to_block,
                expected_hash: previous.hash,
                observed_hash: to_hash,
            });
        }
    }

    let logs = rpc
        .protocol_logs(from_block, to_block)
        .await
        .map_err(RuntimeError::Rpc)?;
    let mut summary = process_raw_logs(service, from_block, to_block, logs)?;
    summary.synced_pair_reserves = synced_pair_reserves;
    service.database.record_block(StoredBlock {
        number: to_block,
        hash: to_hash,
    });
    summary.submitted_transactions = service.submit_pending().map_err(RuntimeError::Service)?;
    Ok(Some(summary))
}

async fn sync_pair_reserves<D, C>(
    service: &mut OperatorService<D, C>,
    rpc: &BscRpcClient,
) -> Result<bool, RuntimeError<C::Error>>
where
    D: OperatorDatabase,
    C: ChainClient,
    C::Error: fmt::Debug,
{
    let Some(reserves) = rpc.pair_reserves().await.map_err(RuntimeError::Rpc)? else {
        return Ok(false);
    };
    service.state.pair.token_reserve = reserves.token_reserve;
    service.state.pair.bnb_reserve = reserves.bnb_reserve;
    service.database.save_state(&service.state);
    Ok(true)
}

pub fn process_raw_logs<D, C>(
    service: &mut OperatorService<D, C>,
    from_block: u64,
    to_block: u64,
    logs: Vec<RawLog>,
) -> Result<RuntimeScanSummary, RuntimeError<C::Error>>
where
    D: OperatorDatabase,
    C: ChainClient,
    C::Error: fmt::Debug,
{
    let mut summary = RuntimeScanSummary {
        from_block,
        to_block,
        raw_logs: logs.len(),
        ..RuntimeScanSummary::default()
    };

    for log in logs {
        if let Some(previous) = service.database.last_indexed_block() {
            if previous.number == log.block_number && previous.hash != log.block_hash {
                return Err(RuntimeError::ReorgDetected {
                    block_number: log.block_number,
                    expected_hash: previous.hash,
                    observed_hash: log.block_hash,
                });
            }
        }
        let Some(indexed) = decode_protocol_log(log).map_err(RuntimeError::Decode)? else {
            continue;
        };
        summary.decoded_events += 1;
        match service
            .process_event(indexed)
            .map_err(RuntimeError::Service)?
        {
            EventOutcome::Applied { planned_commands } => {
                summary.applied_events += 1;
                summary.planned_commands += planned_commands;
            }
            EventOutcome::Duplicate => {
                summary.duplicate_events += 1;
            }
        }
    }

    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chain::RecordedClient;
    use crate::config::{ProtocolConfig, BNB};
    use crate::engine::Engine;
    use crate::indexer::{deposit_topic, ref_bound_topic};
    use crate::service::OperatorService;
    use crate::storage::{MemoryDatabase, OperatorDatabase};

    fn topic_address(address: &str) -> String {
        format!("0x{:0>64}", address.trim_start_matches("0x"))
    }

    #[test]
    fn raw_logs_are_decoded_processed_and_planned() {
        let mut service = OperatorService::restore_or_new(
            Engine::new(ProtocolConfig::default()),
            MemoryDatabase::default(),
            RecordedClient::default(),
            "0x9999999999999999999999999999999999999999",
        );
        let user = "0x1111111111111111111111111111111111111111";
        let root = "0x9999999999999999999999999999999999999999";
        let logs = vec![
            RawLog {
                block_number: 10,
                block_hash: "0xblock10".into(),
                tx_hash: "0xaaa".into(),
                log_index: 0,
                topics: vec![ref_bound_topic(), topic_address(user), topic_address(root)],
                data: "0x".into(),
            },
            RawLog {
                block_number: 11,
                block_hash: "0xblock11".into(),
                tx_hash: "0xbbb".into(),
                log_index: 0,
                topics: vec![deposit_topic(), topic_address(user), topic_address(root)],
                data: format!("0x{:064x}", BNB),
            },
        ];

        let summary = process_raw_logs(&mut service, 10, 11, logs).unwrap();
        assert_eq!(summary.raw_logs, 2);
        assert_eq!(summary.decoded_events, 2);
        assert_eq!(summary.applied_events, 2);
        assert!(summary.planned_commands > 0);
        assert_eq!(service.state.user(user).unwrap().principal_bnb, BNB);
    }

    #[test]
    fn detects_reorg_against_recorded_block() {
        let mut database = MemoryDatabase::default();
        database.record_block(StoredBlock {
            number: 10,
            hash: "0xold".into(),
        });
        let mut service = OperatorService::restore_or_new(
            Engine::new(ProtocolConfig::default()),
            database,
            RecordedClient::default(),
            "root",
        );
        let error = process_raw_logs(
            &mut service,
            10,
            10,
            vec![RawLog {
                block_number: 10,
                block_hash: "0xnew".into(),
                tx_hash: "0xaaa".into(),
                log_index: 0,
                topics: Vec::new(),
                data: "0x".into(),
            }],
        )
        .unwrap_err();
        assert!(matches!(error, RuntimeError::ReorgDetected { .. }));
    }
}
