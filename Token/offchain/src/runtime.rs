use std::fmt;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::chain::ChainClient;
use crate::indexer::{classify_system_log, decode_protocol_log, DecodeError, RawLog, SystemEvent};
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
    pub synced_protocol_config: bool,
    pub synced_nodes: bool,
    pub synced_pair_reserves: bool,
    pub raw_logs: usize,
    pub decoded_events: usize,
    pub applied_events: usize,
    pub duplicate_events: usize,
    pub planned_commands: usize,
    /// Number of `ProtocolConfigUpdated` admin events mirrored to the offchain
    /// history table during this scan.
    pub chain_config_events: usize,
    /// Number of `NodeUpdated` admin events mirrored to the offchain node
    /// history table during this scan.
    pub chain_node_events: usize,
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
    /// Last UTC+8 settlement slot tag (e.g. "2026-05-12T06") whose
    /// settlement we have already scheduled. `None` until the first tick
    /// completes.
    last_settlement_slot: Option<String>,
    /// Last hour slot tag (e.g. "2026-05-12T03") for which deflation was
    /// scheduled.
    last_deflation_slot: Option<String>,
    /// Last minute slot tag for which buyback was scheduled.
    last_buyback_slot: Option<String>,
}

/// Seconds per day. Settlement period seconds are derived dynamically from
/// the current `settlement_periods_per_day` config so that switching from
/// 4 × 6h to 12 × 2h (or any other divisor of 24h) needs no redeploy.
const SECS_PER_DAY: u64 = 86_400;
/// UTC+8 offset applied before truncating slot tags so periods align to
/// Beijing local time (00 / 06 / 12 / 18 for the default 4-per-day cadence,
/// or every 2h on the 12-per-day cadence).
const UTC8_OFFSET_SECS: u64 = 8 * 3600;

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
            last_settlement_slot: None,
            last_deflation_slot: None,
            last_buyback_slot: None,
        }
    }

    pub async fn run_once(&mut self) -> Result<Option<RuntimeScanSummary>, RuntimeError<C::Error>> {
        scan_confirmed_logs_once(&mut self.service, &self.rpc, &self.config).await
    }

    /// Evaluate wall-clock-driven schedules (settlement / deflation / buyback)
    /// and emit any newly due commands. Idempotent across restarts because
    /// every command planned here is keyed by its slot tag at the journal
    /// layer.
    pub fn run_scheduled_ticks(&mut self) -> Result<TickReport, RuntimeError<C::Error>> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or(0);
        let mut report = TickReport::default();

        // Settlement: align to UTC+8 boundaries. The boundary step is
        // `86400 / settlement_periods_per_day` so 4 periods/day → 6h windows,
        // 12 periods/day → 2h windows, etc. Period count is read from the
        // live engine config so the operator picks up any chain-side change
        // on the next tick.
        let periods_per_day = self.service.engine.config.settlement_periods_per_day.max(1) as u64;
        let period_secs = SECS_PER_DAY / periods_per_day;
        let settlement_slot = format_settlement_slot(now, period_secs, periods_per_day);
        if self.last_settlement_slot.as_deref() != Some(settlement_slot.as_str()) {
            report.settled_users = self.service.tick_settlements(&settlement_slot);
            self.last_settlement_slot = Some(settlement_slot);
        }

        // Deflation: hourly slot tag in UTC.
        let deflation_slot = format_hour_slot(now);
        if self.last_deflation_slot.as_deref() != Some(deflation_slot.as_str()) {
            let day = now / 86_400;
            report.deflation_amount = self
                .service
                .tick_deflation(day, &deflation_slot)
                .map_err(RuntimeError::Service)?;
            self.last_deflation_slot = Some(deflation_slot);
        }

        // Buyback: per-minute slot tag in UTC.
        let buyback_slot = format_minute_slot(now);
        if self.last_buyback_slot.as_deref() != Some(buyback_slot.as_str()) {
            report.buyback_amount = self
                .service
                .tick_buyback(&buyback_slot)
                .map_err(RuntimeError::Service)?;
            self.last_buyback_slot = Some(buyback_slot);
        }
        Ok(report)
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
            match self.run_scheduled_ticks() {
                Ok(report) if report.has_activity() => {
                    println!(
                        "operator schedule: settled_users={} deflation={:?} buyback={:?}",
                        report.settled_users, report.deflation_amount, report.buyback_amount,
                    );
                    if let Err(error) = self.service.submit_pending() {
                        eprintln!("scheduled submit_pending failed: {error:?}");
                    }
                }
                Ok(_) => {}
                Err(error) => {
                    eprintln!("scheduled tick failed: {error:?}");
                }
            }
            tokio::time::sleep(self.config.poll_interval).await;
        }
    }
}

#[derive(Debug, Default, Clone)]
pub struct TickReport {
    pub settled_users: usize,
    pub deflation_amount: Option<u128>,
    pub buyback_amount: Option<u128>,
}

impl TickReport {
    fn has_activity(&self) -> bool {
        self.settled_users != 0
            || self.deflation_amount.is_some()
            || self.buyback_amount.is_some()
    }
}

/// Beijing-time period tag. Aligns settlement boundaries to UTC+8 with a
/// configurable `period_secs`. The tag embeds `periods_per_day` so that if
/// the operator changes the cadence (e.g. 4 → 12 settlements/day) the old
/// and new slot tags never collide in the journal — guaranteeing neither
/// duplicate nor skipped payouts across the transition.
fn format_settlement_slot(now_unix: u64, period_secs: u64, periods_per_day: u64) -> String {
    let period_secs = period_secs.max(1);
    let shifted = now_unix.saturating_add(UTC8_OFFSET_SECS);
    let slot_index = shifted / period_secs;
    let slot_start = slot_index * period_secs;
    let (year, month, day, hour) = unix_seconds_to_ymd_hms(slot_start);
    let minute = (slot_start / 60) % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}+08/{periods_per_day}")
}

fn format_hour_slot(now_unix: u64) -> String {
    let slot_start = (now_unix / 3600) * 3600;
    let (year, month, day, hour) = unix_seconds_to_ymd_hms(slot_start);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}Z")
}

fn format_minute_slot(now_unix: u64) -> String {
    let slot_start = (now_unix / 60) * 60;
    let (year, month, day, hour) = unix_seconds_to_ymd_hms(slot_start);
    let minute = (slot_start / 60) % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}Z")
}

/// Convert seconds since the Unix epoch into a calendar `(year, month, day,
/// hour)` tuple. Pure integer arithmetic – avoids pulling in `chrono` purely
/// for slot labels.
fn unix_seconds_to_ymd_hms(timestamp: u64) -> (u64, u64, u64, u64) {
    let days = timestamp / 86_400;
    let seconds_of_day = timestamp % 86_400;
    let hour = seconds_of_day / 3600;
    // Civil-from-days algorithm by Howard Hinnant.
    let z = days as i64 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp.saturating_sub(9) };
    let final_year = if month <= 2 { year + 1 } else { year };
    (final_year as u64, month, day, hour)
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
    let synced_protocol_config = sync_protocol_config(service, rpc).await?;
    let synced_nodes = sync_nodes(service, rpc).await?;
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
    let system_events = collect_system_events(&logs)?;
    let (chain_config_events, chain_node_events) =
        apply_system_events(service, rpc, &system_events).await?;
    let mut summary = process_raw_logs(service, from_block, to_block, logs)?;
    summary.synced_protocol_config = synced_protocol_config;
    summary.synced_nodes = synced_nodes;
    summary.synced_pair_reserves = synced_pair_reserves;
    summary.chain_config_events = chain_config_events;
    summary.chain_node_events = chain_node_events;
    service.database.record_block(StoredBlock {
        number: to_block,
        hash: to_hash,
    });
    summary.submitted_transactions = service.submit_pending().map_err(RuntimeError::Service)?;
    Ok(Some(summary))
}

async fn sync_protocol_config<D, C>(
    service: &mut OperatorService<D, C>,
    rpc: &BscRpcClient,
) -> Result<bool, RuntimeError<C::Error>>
where
    D: OperatorDatabase,
    C: ChainClient,
    C::Error: fmt::Debug,
{
    let chain_config = rpc.protocol_config().await.map_err(RuntimeError::Rpc)?;
    service.engine.config = chain_config.config;
    Ok(true)
}

/// Pre-scan the freshly fetched logs and group admin-state events so the
/// runtime can mirror them with full provenance into the offchain history
/// tables.
fn collect_system_events<E>(logs: &[RawLog]) -> Result<Vec<SystemEvent>, RuntimeError<E>>
where
    E: fmt::Debug,
{
    let mut events = Vec::new();
    for log in logs {
        if let Some(event) = classify_system_log(log).map_err(RuntimeError::Decode)? {
            events.push(event);
        }
    }
    Ok(events)
}

/// Persist immediate-mirror history rows for any admin-state changes detected
/// in this scan. Returns (config_event_count, node_event_count).
async fn apply_system_events<D, C>(
    service: &mut OperatorService<D, C>,
    rpc: &BscRpcClient,
    events: &[SystemEvent],
) -> Result<(usize, usize), RuntimeError<C::Error>>
where
    D: OperatorDatabase,
    C: ChainClient,
    C::Error: fmt::Debug,
{
    let mut config_count = 0usize;
    let mut node_count = 0usize;
    for event in events {
        match event {
            SystemEvent::ProtocolConfigUpdated {
                block_number,
                tx_hash,
            } => {
                let chain_config = rpc.protocol_config().await.map_err(RuntimeError::Rpc)?;
                let updated_by = format!("chain-event:{tx_hash}");
                if service.database.record_protocol_config(
                    &chain_config.config,
                    &updated_by,
                    Some(*block_number),
                    Some(tx_hash),
                ) {
                    config_count += 1;
                }
                service.engine.config = chain_config.config;
            }
            SystemEvent::NodeUpdated {
                block_number,
                tx_hash,
                node,
                weight,
            } => {
                let updated_by = format!("chain-event:{tx_hash}");
                if service.database.record_node_update(
                    node,
                    *weight,
                    &updated_by,
                    Some(*block_number),
                    Some(tx_hash),
                ) {
                    node_count += 1;
                }
            }
        }
    }
    if config_count + node_count > 0 {
        // Refresh full node set after any admin event so in-memory state stays
        // consistent with the chain.
        let nodes = rpc.nodes().await.map_err(RuntimeError::Rpc)?;
        service.state.nodes = nodes;
        service.database.save_state(&service.state);
    }
    Ok((config_count, node_count))
}

async fn sync_nodes<D, C>(
    service: &mut OperatorService<D, C>,
    rpc: &BscRpcClient,
) -> Result<bool, RuntimeError<C::Error>>
where
    D: OperatorDatabase,
    C: ChainClient,
    C::Error: fmt::Debug,
{
    service.state.nodes = rpc.nodes().await.map_err(RuntimeError::Rpc)?;
    service.database.save_state(&service.state);
    Ok(true)
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
