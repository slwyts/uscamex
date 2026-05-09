use crate::config::Wei;
use crate::journal::ExecutionJournal;
use crate::state::ProtocolState;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HealthConfig {
    pub max_indexer_lag_blocks: u64,
    pub max_pending_commands: usize,
    pub min_operator_bnb: Wei,
    pub max_reserve_drift_bps: u16,
    pub deflation_daily_cap_bps: u16,
}

impl Default for HealthConfig {
    fn default() -> Self {
        Self {
            max_indexer_lag_blocks: 12,
            max_pending_commands: 0,
            min_operator_bnb: 100_000_000_000_000_000,
            max_reserve_drift_bps: 30,
            deflation_daily_cap_bps: 200,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HealthAlert {
    IndexerLag {
        lag_blocks: u64,
    },
    PendingCommands {
        count: usize,
    },
    LowOperatorBnb {
        balance: Wei,
    },
    PairReserveDrift {
        token_drift_bps: u16,
        bnb_drift_bps: u16,
    },
    DailyDeflationCapReached,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HealthSnapshot {
    pub chain_head: u64,
    pub indexed_block: u64,
    pub operator_bnb: Wei,
    pub observed_pair_token: Wei,
    pub observed_pair_bnb: Wei,
}

pub fn check_health(
    config: &HealthConfig,
    state: &ProtocolState,
    journal: &ExecutionJournal,
    snapshot: &HealthSnapshot,
) -> Vec<HealthAlert> {
    let mut alerts = Vec::new();
    let lag_blocks = snapshot.chain_head.saturating_sub(snapshot.indexed_block);
    let pending_count = journal.pending_commands().len();
    let token_drift_bps = drift_bps(state.pair.token_reserve, snapshot.observed_pair_token);
    let bnb_drift_bps = drift_bps(state.pair.bnb_reserve, snapshot.observed_pair_bnb);

    if lag_blocks > config.max_indexer_lag_blocks {
        alerts.push(HealthAlert::IndexerLag { lag_blocks });
    }
    if pending_count > config.max_pending_commands {
        alerts.push(HealthAlert::PendingCommands {
            count: pending_count,
        });
    }
    if snapshot.operator_bnb < config.min_operator_bnb {
        alerts.push(HealthAlert::LowOperatorBnb {
            balance: snapshot.operator_bnb,
        });
    }
    if token_drift_bps > config.max_reserve_drift_bps
        || bnb_drift_bps > config.max_reserve_drift_bps
    {
        alerts.push(HealthAlert::PairReserveDrift {
            token_drift_bps,
            bnb_drift_bps,
        });
    }
    if state.deflation_used_bps >= config.deflation_daily_cap_bps {
        alerts.push(HealthAlert::DailyDeflationCapReached);
    }
    alerts
}

fn drift_bps(expected: Wei, observed: Wei) -> u16 {
    if expected == observed {
        return 0;
    }
    if expected == 0 {
        return u16::MAX;
    }
    let diff = expected.max(observed) - expected.min(observed);
    ((diff.saturating_mul(10_000) / expected).min(u128::from(u16::MAX))) as u16
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::BNB;
    use crate::executor::OperatorCommand;

    #[test]
    fn health_alerts_cover_operational_blockers() {
        let config = HealthConfig::default();
        let mut state = ProtocolState::new("root");
        state.pair.token_reserve = 1_000 * BNB;
        state.pair.bnb_reserve = 10 * BNB;
        state.deflation_used_bps = 200;
        let mut journal = ExecutionJournal::default();
        journal.plan_batch(
            "deposit:1",
            vec![OperatorCommand::CreditVault { amount: BNB }],
        );

        let snapshot = HealthSnapshot {
            chain_head: 100,
            indexed_block: 80,
            operator_bnb: BNB / 100,
            observed_pair_token: 900 * BNB,
            observed_pair_bnb: 10 * BNB,
        };
        let alerts = check_health(&config, &state, &journal, &snapshot);
        assert!(alerts
            .iter()
            .any(|alert| matches!(alert, HealthAlert::IndexerLag { .. })));
        assert!(alerts
            .iter()
            .any(|alert| matches!(alert, HealthAlert::PendingCommands { .. })));
        assert!(alerts
            .iter()
            .any(|alert| matches!(alert, HealthAlert::LowOperatorBnb { .. })));
        assert!(alerts
            .iter()
            .any(|alert| matches!(alert, HealthAlert::PairReserveDrift { .. })));
        assert!(alerts
            .iter()
            .any(|alert| matches!(alert, HealthAlert::DailyDeflationCapReached)));
    }
}
