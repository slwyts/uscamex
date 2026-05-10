use std::fmt;

use crate::chain::{submit_pending, ChainClient, SubmitPendingError};
use crate::engine::{Engine, EngineError};
use crate::executor::{commands_for_deposit, commands_for_settlement, OperatorCommand};
use crate::indexer::{ChainEvent, IndexedEvent};
use crate::journal::ExecutionJournal;
use crate::state::{Address, ProtocolState};
use crate::storage::OperatorDatabase;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServiceError<ChainError> {
    Engine(EngineError),
    Submit(SubmitPendingError<ChainError>),
}

impl<ChainError: fmt::Debug> fmt::Display for ServiceError<ChainError> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl<ChainError: fmt::Debug> std::error::Error for ServiceError<ChainError> {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EventOutcome {
    Applied { planned_commands: usize },
    Duplicate,
}

#[derive(Debug, Clone)]
pub struct OperatorService<D, C> {
    pub engine: Engine,
    pub state: ProtocolState,
    pub journal: ExecutionJournal,
    pub database: D,
    pub chain: C,
}

impl<D, C> OperatorService<D, C>
where
    D: OperatorDatabase,
    C: ChainClient,
    C::Error: fmt::Debug,
{
    pub fn restore_or_new(engine: Engine, database: D, chain: C, root: impl Into<Address>) -> Self {
        let state = database
            .load_state()
            .unwrap_or_else(|| ProtocolState::new(root));
        let journal = database.load_journal();
        Self {
            engine,
            state,
            journal,
            database,
            chain,
        }
    }

    pub fn process_event(
        &mut self,
        indexed: IndexedEvent,
    ) -> Result<EventOutcome, ServiceError<C::Error>> {
        let event_id = indexed.id();
        if self.database.contains_event(&event_id)
            || self.state.processed_events.contains(&event_id)
        {
            return Ok(EventOutcome::Duplicate);
        }

        let planned_commands = match indexed.event.clone() {
            ChainEvent::RefBound { user, referrer, .. } => {
                // Tolerate any self-referral RefBound(x, x): emitted both by
                // the on-chain constructor (root bootstrap) and by
                // transferOwnership when the new owner has no upline yet.
                if user == referrer {
                    if !self.state.is_bound(&user) {
                        self.state.ensure_user_mut(&user);
                    }
                    0
                } else {
                    self.engine
                        .bind(&mut self.state, user, referrer)
                        .map_err(ServiceError::Engine)?;
                    0
                }
            }
            ChainEvent::Deposit { user, amount, .. } => {
                let allocation = self
                    .engine
                    .deposit(&mut self.state, user, amount)
                    .map_err(ServiceError::Engine)?;
                let commands = commands_for_deposit(&allocation);
                let count = commands.len();
                self.journal
                    .plan_batch(&format!("deposit:{event_id}"), commands);
                count
            }
        };

        self.state.processed_events.insert(event_id);
        self.database.insert_event(indexed.stored());
        self.persist();
        Ok(EventOutcome::Applied { planned_commands })
    }

    pub fn settle_once(
        &mut self,
        user: impl Into<Address>,
        period_key: impl Into<String>,
    ) -> Result<Option<Vec<OperatorCommand>>, ServiceError<C::Error>> {
        let user = user.into();
        let period_key = period_key.into();
        let Some(settlement) = self
            .engine
            .settle_static_period_once(&mut self.state, user.clone(), period_key.clone())
            .map_err(ServiceError::Engine)?
        else {
            return Ok(None);
        };
        let commands = commands_for_settlement(&settlement);
        self.journal
            .plan_batch(&format!("static:{user}:{period_key}"), commands.clone());
        self.persist();
        Ok(Some(commands))
    }

    pub fn submit_pending(&mut self) -> Result<Vec<String>, ServiceError<C::Error>> {
        let result = submit_pending(&mut self.chain, &mut self.journal);
        self.database.save_journal(&self.journal);
        result.map_err(ServiceError::Submit)
    }

    fn persist(&mut self) {
        self.database.save_state(&self.state);
        self.database.save_journal(&self.journal);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chain::RecordedClient;
    use crate::config::{ProtocolConfig, BNB};
    use crate::engine::Engine;
    use crate::journal::CommandStatus;
    use crate::storage::{MemoryDatabase, OperatorDatabase};

    fn service() -> OperatorService<MemoryDatabase, RecordedClient> {
        OperatorService::restore_or_new(
            Engine::new(ProtocolConfig::default()),
            MemoryDatabase::default(),
            RecordedClient::default(),
            "root",
        )
    }

    #[test]
    fn service_persists_events_plans_commands_and_submits_pending() {
        let mut service = service();
        let bind = IndexedEvent {
            block_number: 1,
            block_hash: "0xblock1".into(),
            tx_hash: "0xbind".into(),
            log_index: 0,
            event: ChainEvent::RefBound {
                id: "0xbind:0".into(),
                user: "alice".into(),
                referrer: "root".into(),
            },
        };
        assert_eq!(
            service.process_event(bind),
            Ok(EventOutcome::Applied {
                planned_commands: 0
            })
        );

        let deposit = IndexedEvent {
            block_number: 2,
            block_hash: "0xblock2".into(),
            tx_hash: "0xdeposit".into(),
            log_index: 0,
            event: ChainEvent::Deposit {
                id: "0xdeposit:0".into(),
                user: "alice".into(),
                amount: BNB,
            },
        };
        let outcome = service.process_event(deposit.clone()).unwrap();
        assert!(
            matches!(outcome, EventOutcome::Applied { planned_commands } if planned_commands > 0)
        );
        assert_eq!(service.process_event(deposit), Ok(EventOutcome::Duplicate));
        assert!(service.database.contains_event("0xdeposit:0"));

        let tx_hashes = service.submit_pending().unwrap();
        assert!(!tx_hashes.is_empty());
        assert!(service
            .journal
            .records
            .values()
            .all(|record| matches!(record.status, CommandStatus::Submitted { .. })));
    }

    #[test]
    fn service_recovers_from_database_snapshot_and_only_submits_unconfirmed() {
        let mut service = service();
        service
            .process_event(IndexedEvent {
                block_number: 1,
                block_hash: "0xblock1".into(),
                tx_hash: "0xbind".into(),
                log_index: 0,
                event: ChainEvent::RefBound {
                    id: "0xbind:0".into(),
                    user: "alice".into(),
                    referrer: "root".into(),
                },
            })
            .unwrap();
        service
            .process_event(IndexedEvent {
                block_number: 2,
                block_hash: "0xblock2".into(),
                tx_hash: "0xdeposit".into(),
                log_index: 0,
                event: ChainEvent::Deposit {
                    id: "0xdeposit:0".into(),
                    user: "alice".into(),
                    amount: BNB,
                },
            })
            .unwrap();

        let first_id = service.journal.records.keys().next().unwrap().clone();
        service
            .journal
            .mark_submitted(&first_id, "0xsubmitted")
            .unwrap();
        service.journal.mark_confirmed(&first_id).unwrap();
        service.database.save_journal(&service.journal);
        let expected_pending = service.journal.pending_commands().len();

        let snapshot = service.database.snapshot();
        let mut restarted = OperatorService::restore_or_new(
            Engine::new(ProtocolConfig::default()),
            MemoryDatabase::from_snapshot(snapshot),
            RecordedClient::default(),
            "root",
        );
        assert_eq!(restarted.state.user("alice").unwrap().principal_bnb, BNB);
        let hashes = restarted.submit_pending().unwrap();
        assert_eq!(hashes.len(), expected_pending);
        assert_eq!(restarted.chain.submitted.len(), expected_pending);
    }

    #[test]
    fn service_settlement_uses_period_idempotency() {
        let mut service = service();
        service
            .engine
            .bind(&mut service.state, "alice", "root")
            .unwrap();
        service
            .engine
            .deposit(&mut service.state, "alice", BNB)
            .unwrap();
        service.database.save_state(&service.state);

        let first = service.settle_once("alice", "2026-05-10T00").unwrap();
        assert!(first.is_some());
        let duplicate = service.settle_once("alice", "2026-05-10T00").unwrap();
        assert!(duplicate.is_none());
    }
}
