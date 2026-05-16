use std::fmt;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::chain::ChainClient;
use crate::indexer::{classify_system_log, decode_protocol_log, DecodeError, RawLog, SystemEvent};
use crate::rpc::{BscRpcClient, RpcError};
use crate::service::{EventOutcome, OperatorService, ServiceError};
use crate::storage::{OperatorDatabase, StoredBlock};
use crate::ws::WsRuntimeState;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeScanConfig {
    pub start_block: u64,
    pub confirmations: u64,
    pub max_blocks_per_scan: u64,
    pub poll_interval: Duration,
    pub protocol_config_interval: Duration,
    pub nodes_interval: Duration,
    pub pair_reserves_interval: Duration,
    pub vault_balance_interval: Duration,
    pub failure_backoff_max: Duration,
    pub ws_stale_after: Duration,
    pub ws_gap_scan_blocks: u64,
    pub ws_reconcile_interval: Duration,
}

impl RuntimeScanConfig {
    pub fn new(start_block: u64, confirmations: u64) -> Self {
        Self {
            start_block,
            confirmations: confirmations.max(1),
            max_blocks_per_scan: 1_000,
            poll_interval: Duration::from_secs(5),
            protocol_config_interval: Duration::from_secs(300),
            nodes_interval: Duration::from_secs(60),
            pair_reserves_interval: Duration::from_secs(30),
            vault_balance_interval: Duration::from_secs(30),
            failure_backoff_max: Duration::from_secs(30),
            ws_stale_after: Duration::from_secs(30),
            ws_gap_scan_blocks: 100,
            ws_reconcile_interval: Duration::from_secs(300),
        }
    }
}

#[derive(Debug, Clone, Default)]
struct RuntimeSyncState {
    last_protocol_config_sync: Option<Instant>,
    last_nodes_sync: Option<Instant>,
    last_pair_reserves_sync: Option<Instant>,
    last_vault_balance_sync: Option<Instant>,
    last_ws_reconcile: Option<Instant>,
}

impl RuntimeSyncState {
    fn is_due(last_sync: Option<Instant>, now: Instant, interval: Duration) -> bool {
        last_sync
            .map(|last_sync| now.duration_since(last_sync) >= interval)
            .unwrap_or(true)
    }

    fn protocol_config_due(&self, now: Instant, interval: Duration) -> bool {
        Self::is_due(self.last_protocol_config_sync, now, interval)
    }

    fn nodes_due(&self, now: Instant, interval: Duration) -> bool {
        Self::is_due(self.last_nodes_sync, now, interval)
    }

    fn pair_reserves_due(&self, now: Instant, interval: Duration) -> bool {
        Self::is_due(self.last_pair_reserves_sync, now, interval)
    }

    fn vault_balance_due(&self, now: Instant, interval: Duration) -> bool {
        Self::is_due(self.last_vault_balance_sync, now, interval)
    }

    fn ws_reconcile_due(&self, now: Instant, interval: Duration) -> bool {
        Self::is_due(self.last_ws_reconcile, now, interval)
    }

    fn mark_protocol_config(&mut self, now: Instant) {
        self.last_protocol_config_sync = Some(now);
    }

    fn mark_nodes(&mut self, now: Instant) {
        self.last_nodes_sync = Some(now);
    }

    fn mark_pair_reserves(&mut self, now: Instant) {
        self.last_pair_reserves_sync = Some(now);
    }

    fn mark_vault_balance(&mut self, now: Instant) {
        self.last_vault_balance_sync = Some(now);
    }

    fn mark_ws_reconcile(&mut self, now: Instant) {
        self.last_ws_reconcile = Some(now);
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RuntimeScanSummary {
    pub from_block: u64,
    pub to_block: u64,
    pub synced_protocol_config: bool,
    pub synced_nodes: bool,
    pub synced_pair_reserves: bool,
    pub synced_vault_balance: bool,
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
    sync_state: RuntimeSyncState,
    ws_state: Option<WsRuntimeState>,
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
            sync_state: RuntimeSyncState::default(),
            ws_state: None,
        }
    }

    pub fn with_ws_state(mut self, ws_state: WsRuntimeState) -> Self {
        self.ws_state = Some(ws_state);
        self
    }

    pub async fn run_once(&mut self) -> Result<Option<RuntimeScanSummary>, RuntimeError<C::Error>> {
        scan_confirmed_logs_once_with_sync_state(
            &mut self.service,
            &self.rpc,
            &self.config,
            &mut self.sync_state,
            self.ws_state.as_ref(),
        )
        .await
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
        let mut consecutive_scan_failures = 0u32;
        loop {
            match self.run_once().await {
                Ok(Some(summary)) => {
                    consecutive_scan_failures = 0;
                    if summary.raw_logs != 0 || !summary.submitted_transactions.is_empty() {
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
                }
                Ok(None) => {
                    consecutive_scan_failures = 0;
                }
                Err(error) => {
                    consecutive_scan_failures = consecutive_scan_failures.saturating_add(1);
                    eprintln!(
                        "operator scan failed (consecutive_failures={}): {error:?}",
                        consecutive_scan_failures
                    );
                }
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
            tokio::time::sleep(scan_sleep_duration(
                self.config.poll_interval,
                self.config.failure_backoff_max,
                consecutive_scan_failures,
            ))
            .await;
        }
    }
}

fn scan_sleep_duration(
    poll_interval: Duration,
    failure_backoff_max: Duration,
    consecutive_failures: u32,
) -> Duration {
    if consecutive_failures == 0 {
        return poll_interval;
    }
    let max_backoff = failure_backoff_max.max(poll_interval);
    let factor = 1u32 << consecutive_failures.saturating_sub(1).min(4);
    poll_interval
        .checked_mul(factor)
        .unwrap_or(max_backoff)
        .min(max_backoff)
}

#[derive(Debug, Default, Clone)]
pub struct TickReport {
    pub settled_users: usize,
    pub deflation_amount: Option<u128>,
    pub buyback_amount: Option<u128>,
}

impl TickReport {
    fn has_activity(&self) -> bool {
        self.settled_users != 0 || self.deflation_amount.is_some() || self.buyback_amount.is_some()
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
    let month = if mp < 10 {
        mp + 3
    } else {
        mp.saturating_sub(9)
    };
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
    let mut sync_state = RuntimeSyncState::default();
    scan_confirmed_logs_once_with_sync_state(service, rpc, config, &mut sync_state, None).await
}

async fn scan_confirmed_logs_once_with_sync_state<D, C>(
    service: &mut OperatorService<D, C>,
    rpc: &BscRpcClient,
    config: &RuntimeScanConfig,
    sync_state: &mut RuntimeSyncState,
    ws_state: Option<&WsRuntimeState>,
) -> Result<Option<RuntimeScanSummary>, RuntimeError<C::Error>>
where
    D: OperatorDatabase,
    C: ChainClient,
    C::Error: fmt::Debug,
{
    let now = Instant::now();
    let ws_snapshot = ws_state.map(|state| state.snapshot(config.ws_stale_after));
    let ws_usable = ws_snapshot.as_ref().is_some_and(|snapshot| {
        snapshot.connected && !snapshot.stale && snapshot.last_head.is_some()
    });
    let chain_head = if ws_usable {
        ws_snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.last_head.as_ref())
            .map(|head| head.number)
            .unwrap_or(0)
    } else {
        rpc.block_number().await.map_err(RuntimeError::Rpc)?
    };
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
    let synced_protocol_config =
        if sync_state.protocol_config_due(now, config.protocol_config_interval) {
            let synced = sync_protocol_config(service, rpc).await?;
            sync_state.mark_protocol_config(now);
            synced
        } else {
            false
        };
    let synced_nodes = if sync_state.nodes_due(now, config.nodes_interval) {
        let synced = sync_nodes(service, rpc).await?;
        sync_state.mark_nodes(now);
        synced
    } else {
        false
    };
    let synced_pair_reserves = if sync_state.pair_reserves_due(now, config.pair_reserves_interval) {
        let synced = sync_pair_reserves(service, rpc).await?;
        sync_state.mark_pair_reserves(now);
        synced
    } else {
        false
    };
    let synced_vault_balance = if sync_state.vault_balance_due(now, config.vault_balance_interval) {
        let synced = sync_vault_balance(service, rpc).await?;
        sync_state.mark_vault_balance(now);
        synced
    } else {
        false
    };
    let first_ws_head = ws_snapshot
        .as_ref()
        .and_then(|snapshot| snapshot.first_head);
    let ws_covers_range = ws_usable
        && first_ws_head
            .map(|first_head| from_block > first_head)
            .unwrap_or(false);
    let reconcile_due = ws_usable && sync_state.ws_reconcile_due(now, config.ws_reconcile_interval);
    let use_http_logs = !ws_covers_range || reconcile_due;
    let max_scan_blocks = if use_http_logs {
        config
            .ws_gap_scan_blocks
            .max(1)
            .min(config.max_blocks_per_scan.max(1))
    } else {
        config.max_blocks_per_scan.max(1)
    };
    let to_block = from_block
        .saturating_add(max_scan_blocks.saturating_sub(1))
        .min(safe_head);
    let to_hash = ws_state
        .and_then(|state| state.recent_head_hash(to_block))
        .unwrap_or_else(|| String::new());
    let to_hash = if to_hash.is_empty() {
        rpc.block_hash(to_block).await.map_err(RuntimeError::Rpc)?
    } else {
        to_hash
    };
    if let Some(previous) = service.database.last_indexed_block() {
        if previous.number == to_block && previous.hash != to_hash {
            return Err(RuntimeError::ReorgDetected {
                block_number: to_block,
                expected_hash: previous.hash,
                observed_hash: to_hash,
            });
        }
    }

    let logs = if use_http_logs {
        let logs = rpc
            .protocol_logs(from_block, to_block)
            .await
            .map_err(RuntimeError::Rpc)?;
        if ws_usable {
            sync_state.mark_ws_reconcile(now);
        }
        logs
    } else {
        ws_state
            .map(|state| state.drain_logs(from_block, to_block))
            .unwrap_or_default()
    };
    let system_events = collect_system_events(&logs)?;
    let saw_config_event = system_events
        .iter()
        .any(|event| matches!(event, SystemEvent::ProtocolConfigUpdated { .. }));
    let saw_node_event = system_events
        .iter()
        .any(|event| matches!(event, SystemEvent::NodeUpdated { .. }));
    let (chain_config_events, chain_node_events) =
        apply_system_events(service, rpc, &system_events).await?;
    let event_sync_at = Instant::now();
    if saw_config_event {
        sync_state.mark_protocol_config(event_sync_at);
    }
    if saw_config_event || saw_node_event {
        sync_state.mark_nodes(event_sync_at);
    }
    let mut summary = process_raw_logs(service, from_block, to_block, logs)?;
    summary.synced_protocol_config = synced_protocol_config;
    summary.synced_nodes = synced_nodes;
    summary.synced_pair_reserves = synced_pair_reserves;
    summary.synced_vault_balance = synced_vault_balance;
    summary.chain_config_events = chain_config_events;
    summary.chain_node_events = chain_node_events;
    service.database.record_block(StoredBlock {
        number: to_block,
        hash: to_hash,
    });
    match service.submit_pending() {
        Ok(transactions) => summary.submitted_transactions = transactions,
        Err(error) => eprintln!("scan submit_pending failed: {error:?}"),
    }
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
    if !chain_config.buy_enabled {
        service.engine.config.buyback_enabled = false;
    }
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
                if !chain_config.buy_enabled {
                    service.engine.config.buyback_enabled = false;
                }
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

async fn sync_vault_balance<D, C>(
    service: &mut OperatorService<D, C>,
    rpc: &BscRpcClient,
) -> Result<bool, RuntimeError<C::Error>>
where
    D: OperatorDatabase,
    C: ChainClient,
    C::Error: fmt::Debug,
{
    let vault = rpc.vault().await.map_err(RuntimeError::Rpc)?;
    service.state.balances.vault_bnb =
        rpc.native_balance(vault).await.map_err(RuntimeError::Rpc)?;
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
