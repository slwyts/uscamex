use std::collections::BTreeMap;

use crate::executor::OperatorCommand;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum CommandStatus {
    Pending,
    Submitted { tx_hash: String },
    Confirmed { tx_hash: String },
    Failed { error: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandRecord {
    pub id: String,
    pub command: OperatorCommand,
    pub attempts: u32,
    pub status: CommandStatus,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JournalError {
    MissingCommand,
    AlreadyConfirmed,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecutionJournal {
    pub records: BTreeMap<String, CommandRecord>,
}

impl ExecutionJournal {
    pub fn plan_batch(&mut self, batch_key: &str, commands: Vec<OperatorCommand>) -> Vec<String> {
        commands
            .into_iter()
            .enumerate()
            .map(|(index, command)| {
                let id = format!("{batch_key}:{index}:{}", command.kind());
                self.records.entry(id.clone()).or_insert(CommandRecord {
                    id: id.clone(),
                    command,
                    attempts: 0,
                    status: CommandStatus::Pending,
                });
                id
            })
            .collect()
    }

    pub fn pending_commands(&self) -> Vec<(String, OperatorCommand)> {
        self.records
            .values()
            .filter(|record| matches!(record.status, CommandStatus::Pending))
            .map(|record| (record.id.clone(), record.command.clone()))
            .collect()
    }

    pub fn mark_submitted(
        &mut self,
        id: &str,
        tx_hash: impl Into<String>,
    ) -> Result<(), JournalError> {
        let record = self
            .records
            .get_mut(id)
            .ok_or(JournalError::MissingCommand)?;
        if matches!(record.status, CommandStatus::Confirmed { .. }) {
            return Err(JournalError::AlreadyConfirmed);
        }
        record.attempts += 1;
        record.status = CommandStatus::Submitted {
            tx_hash: tx_hash.into(),
        };
        Ok(())
    }

    pub fn mark_confirmed(&mut self, id: &str) -> Result<(), JournalError> {
        let record = self
            .records
            .get_mut(id)
            .ok_or(JournalError::MissingCommand)?;
        let tx_hash = match &record.status {
            CommandStatus::Submitted { tx_hash } | CommandStatus::Confirmed { tx_hash } => {
                tx_hash.clone()
            }
            CommandStatus::Pending | CommandStatus::Failed { .. } => String::new(),
        };
        record.status = CommandStatus::Confirmed { tx_hash };
        Ok(())
    }

    pub fn mark_failed(&mut self, id: &str, error: impl Into<String>) -> Result<(), JournalError> {
        let record = self
            .records
            .get_mut(id)
            .ok_or(JournalError::MissingCommand)?;
        if matches!(record.status, CommandStatus::Confirmed { .. }) {
            return Err(JournalError::AlreadyConfirmed);
        }
        record.status = CommandStatus::Failed {
            error: error.into(),
        };
        Ok(())
    }

    pub fn confirmed_count(&self) -> usize {
        self.records
            .values()
            .filter(|record| matches!(record.status, CommandStatus::Confirmed { .. }))
            .count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batch_planning_is_idempotent_and_failed_commands_are_manual() {
        let mut journal = ExecutionJournal::default();
        let commands = vec![
            OperatorCommand::CreditVault { amount: 1 },
            OperatorCommand::TransferBnb {
                to: "alice".into(),
                amount: 2,
                reason: "direct".into(),
            },
        ];
        let first = journal.plan_batch("deposit:tx1:0", commands.clone());
        let second = journal.plan_batch("deposit:tx1:0", commands);
        assert_eq!(first, second);
        assert_eq!(journal.records.len(), 2);

        journal.mark_submitted(&first[0], "0xaaa").unwrap();
        journal.mark_confirmed(&first[0]).unwrap();
        journal.mark_failed(&first[1], "nonce-too-low").unwrap();

        let pending = journal.pending_commands();
        assert!(pending.is_empty());
        assert_eq!(journal.confirmed_count(), 1);
    }
}
