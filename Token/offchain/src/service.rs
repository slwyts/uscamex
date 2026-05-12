use std::fmt;

use crate::chain::{submit_pending, ChainClient, SubmitPendingError};
use crate::config::BPS_DENOMINATOR;
use crate::engine::{Engine, EngineError, TaxSide};
use crate::executor::{commands_for_deposit, commands_for_settlement, OperatorCommand};
use crate::indexer::{ChainEvent, IndexedEvent};
use crate::journal::ExecutionJournal;
use crate::state::{Address, ProtocolState};
use crate::storage::OperatorDatabase;
use ethers_core::types::U256;

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
            ChainEvent::TaxCollected { amount, side, .. } => {
                match self.plan_tax_sweep(amount, side)? {
                    Some(command) => {
                        self.journal
                            .plan_batch(&format!("tax:{event_id}"), vec![command]);
                        1
                    }
                    None => 0,
                }
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

    /// Iterate every active user and run one settlement period for them.
    /// Returns the number of users newly settled (excludes idempotent skips
    /// and inactive accounts).
    pub fn tick_settlements(&mut self, period_key: impl Into<String>) -> usize {
        let period_key = period_key.into();
        let active_users: Vec<Address> = self
            .state
            .users
            .iter()
            .filter(|(_, account)| account.active && account.principal_bnb > 0)
            .map(|(address, _)| address.clone())
            .collect();
        let mut settled = 0usize;
        for user in active_users {
            match self.settle_once(user, period_key.clone()) {
                Ok(Some(_)) => settled += 1,
                Ok(None) => {}
                Err(_) => {}
            }
        }
        settled
    }

    /// Run one deflation tick (hourly). Returns Some(amount_pulled) when the
    /// command was planned. Caller supplies a slot key like `"day-1:hour-3"`
    /// for cross-restart idempotency at journal level.
    pub fn tick_deflation(
        &mut self,
        day: u64,
        slot_key: impl Into<String>,
    ) -> Result<Option<u128>, ServiceError<C::Error>> {
        let slot_key = slot_key.into();
        let amount = self
            .engine
            .apply_deflation(&mut self.state, day)
            .map_err(ServiceError::Engine)?;
        if amount == 0 {
            self.persist();
            return Ok(None);
        }
        self.journal.plan_batch(
            &format!("deflation:{slot_key}"),
            vec![OperatorCommand::PullPairTokens {
                bps: self.engine.config.deflation_hourly_bps,
            }],
        );
        self.persist();
        Ok(Some(amount))
    }

    /// Run one buyback tick (every minute). `slot_key` is the per-minute
    /// idempotency tag.
    pub fn tick_buyback(
        &mut self,
        slot_key: impl Into<String>,
    ) -> Result<Option<u128>, ServiceError<C::Error>> {
        let slot_key = slot_key.into();
        let vault_before = self.state.balances.vault_bnb;
        let burned = self
            .engine
            .buyback_tick(&mut self.state)
            .map_err(ServiceError::Engine)?;
        if burned == 0 {
            self.persist();
            return Ok(None);
        }
        let spent = vault_before.saturating_sub(self.state.balances.vault_bnb);
        self.journal.plan_batch(
            &format!("buyback:{slot_key}"),
            vec![OperatorCommand::Buyback { bnb_amount: spent }],
        );
        self.persist();
        Ok(Some(burned))
    }

    pub fn submit_pending(&mut self) -> Result<Vec<String>, ServiceError<C::Error>> {
        let result = submit_pending(&mut self.chain, &mut self.journal);
        self.database.save_journal(&self.journal);
        result.map_err(ServiceError::Submit)
    }

    fn plan_tax_sweep(
        &mut self,
        tax_token_amount: u128,
        side: TaxSide,
    ) -> Result<Option<OperatorCommand>, ServiceError<C::Error>> {
        if tax_token_amount == 0 {
            return Ok(None);
        }
        let tax_split = TaxSplit::from_engine(&self.engine, side);
        if tax_split.tax_bps == 0 {
            return Ok(None);
        }

        let gross_bnb_value = gross_bnb_value_from_tax_tokens(
            tax_token_amount,
            tax_split.tax_bps,
            self.state.pair.token_reserve,
            self.state.pair.bnb_reserve,
        );
        self.engine
            .apply_trade_tax(&mut self.state, side, gross_bnb_value)
            .map_err(ServiceError::Engine)?;

        let builder_token_amount =
            prorate_tax_tokens(tax_token_amount, tax_split.builder_bps, tax_split.tax_bps);
        let burn_token_amount =
            prorate_tax_tokens(tax_token_amount, tax_split.burn_bps, tax_split.tax_bps);
        let sell_token_amount = tax_token_amount
            .saturating_sub(builder_token_amount)
            .saturating_sub(burn_token_amount);
        self.state.balances.builder_token_amount = self
            .state
            .balances
            .builder_token_amount
            .saturating_add(builder_token_amount);
        self.state.balances.burned_tokens = self
            .state
            .balances
            .burned_tokens
            .saturating_add(burn_token_amount);

        if burn_token_amount == 0 && sell_token_amount == 0 {
            return Ok(None);
        }

        let owner_bnb_bps_of_sold = split_bps_of_sold(tax_split.owner_bps, tax_split.sell_bps);
        let vault_bnb_bps_of_sold = if tax_split.vault_bps == 0 {
            0
        } else {
            (BPS_DENOMINATOR as u16).saturating_sub(owner_bnb_bps_of_sold)
        };

        Ok(Some(OperatorCommand::SweepTaxToBnb {
            tax_token_amount,
            builder_token_amount,
            burn_token_amount,
            owner_bnb_bps_of_sold,
            vault_bnb_bps_of_sold,
        }))
    }

    fn persist(&mut self) {
        self.database.save_state(&self.state);
        self.database.save_journal(&self.journal);
    }
}

#[derive(Debug, Clone, Copy)]
struct TaxSplit {
    tax_bps: u16,
    builder_bps: u16,
    owner_bps: u16,
    vault_bps: u16,
    burn_bps: u16,
    sell_bps: u16,
}

impl TaxSplit {
    fn from_engine(engine: &Engine, side: TaxSide) -> Self {
        match side {
            TaxSide::Buy => Self::new(
                engine.config.buy_tax_bps,
                engine.config.buy_tax_builder_bps,
                0,
                engine.config.buy_tax_vault_bps,
            ),
            TaxSide::Sell => Self::new(
                engine.config.sell_tax_bps,
                engine.config.sell_tax_builder_bps,
                engine.config.sell_tax_owner_bps,
                engine.config.sell_tax_vault_bps,
            ),
        }
    }

    fn new(tax_bps: u16, builder_bps: u16, owner_bps: u16, vault_bps: u16) -> Self {
        let distributed = builder_bps
            .saturating_add(owner_bps)
            .saturating_add(vault_bps);
        let burn_bps = tax_bps.saturating_sub(distributed);
        let sell_bps = owner_bps.saturating_add(vault_bps);
        Self {
            tax_bps,
            builder_bps,
            owner_bps,
            vault_bps,
            burn_bps,
            sell_bps,
        }
    }
}

fn gross_bnb_value_from_tax_tokens(
    tax_token_amount: u128,
    tax_bps: u16,
    token_reserve: u128,
    bnb_reserve: u128,
) -> u128 {
    if tax_bps == 0 || token_reserve == 0 || bnb_reserve == 0 {
        return 0;
    }
    (U256::from(tax_token_amount)
        .saturating_mul(U256::from(BPS_DENOMINATOR))
        .saturating_mul(U256::from(bnb_reserve))
        / U256::from(tax_bps)
        / U256::from(token_reserve))
    .as_u128()
}

fn prorate_tax_tokens(tax_token_amount: u128, part_bps: u16, tax_bps: u16) -> u128 {
    if part_bps == 0 || tax_bps == 0 {
        return 0;
    }
    (U256::from(tax_token_amount) * U256::from(part_bps) / U256::from(tax_bps)).as_u128()
}

fn split_bps_of_sold(part_bps: u16, sell_bps: u16) -> u16 {
    if part_bps == 0 || sell_bps == 0 {
        return 0;
    }
    ((u32::from(part_bps) * BPS_DENOMINATOR as u32) / u32::from(sell_bps)) as u16
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
            .all(|record| matches!(record.status, CommandStatus::Confirmed { .. })));
    }

    #[test]
    fn service_plans_tax_sweep_from_tax_collected_event() {
        let mut service = service();
        service.state.pair.token_reserve = 1_000 * BNB;
        service.state.pair.bnb_reserve = 10 * BNB;

        let tax = IndexedEvent {
            block_number: 3,
            block_hash: "0xblock3".into(),
            tx_hash: "0xtax".into(),
            log_index: 0,
            event: ChainEvent::TaxCollected {
                id: "0xtax:0".into(),
                from: "0xpair".into(),
                to: "0xalice".into(),
                amount: 3 * BNB,
                side: TaxSide::Buy,
            },
        };

        assert_eq!(
            service.process_event(tax),
            Ok(EventOutcome::Applied {
                planned_commands: 1
            })
        );
        assert_eq!(service.state.balances.builder_token_amount, BNB);
        assert_eq!(service.state.balances.builder_token_value_bnb, BNB / 100);
        assert_eq!(service.state.balances.vault_bnb, 2 * BNB / 100);
        let command = &service.journal.records["tax:0xtax:0:0:sweep-tax-to-bnb"].command;
        assert!(matches!(
            command,
            OperatorCommand::SweepTaxToBnb {
                tax_token_amount,
                builder_token_amount,
                burn_token_amount,
                owner_bnb_bps_of_sold,
                vault_bnb_bps_of_sold,
            } if *tax_token_amount == 3 * BNB
                && *builder_token_amount == BNB
                && *burn_token_amount == 0
                && *owner_bnb_bps_of_sold == 0
                && *vault_bnb_bps_of_sold == 10_000
        ));
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
