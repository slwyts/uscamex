use std::convert::Infallible;

use crate::executor::OperatorCommand;
use crate::journal::{ExecutionJournal, JournalError};

pub trait ChainClient {
    type Error;

    fn submit(&mut self, command: &OperatorCommand) -> Result<String, Self::Error>;
}

#[derive(Debug, Default, Clone)]
pub struct RecordedClient {
    pub submitted: Vec<OperatorCommand>,
}

impl ChainClient for RecordedClient {
    type Error = Infallible;

    fn submit(&mut self, command: &OperatorCommand) -> Result<String, Self::Error> {
        self.submitted.push(command.clone());
        Ok(format!("local-tx-{}", self.submitted.len()))
    }
}

pub fn submit_all<C: ChainClient>(
    client: &mut C,
    commands: &[OperatorCommand],
) -> Result<Vec<String>, C::Error> {
    commands
        .iter()
        .map(|command| client.submit(command))
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubmitPendingError<E> {
    Chain(E),
    Journal(JournalError),
}

pub fn submit_pending<C: ChainClient>(
    client: &mut C,
    journal: &mut ExecutionJournal,
) -> Result<Vec<String>, SubmitPendingError<C::Error>> {
    let pending = journal.pending_commands();
    let mut tx_hashes = Vec::new();
    for (id, command) in pending {
        let tx_hash = client.submit(&command).map_err(SubmitPendingError::Chain)?;
        journal
            .mark_submitted(&id, tx_hash.clone())
            .map_err(SubmitPendingError::Journal)?;
        tx_hashes.push(tx_hash);
    }
    Ok(tx_hashes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recorded_client_keeps_submission_order() {
        let mut client = RecordedClient::default();
        let commands = vec![
            OperatorCommand::CreditVault { amount: 1 },
            OperatorCommand::Buyback { bnb_amount: 1 },
        ];
        let hashes = submit_all(&mut client, &commands).unwrap();
        assert_eq!(hashes, vec!["local-tx-1", "local-tx-2"]);
        assert_eq!(client.submitted, commands);
    }

    #[test]
    fn submit_pending_skips_confirmed_commands() {
        let mut client = RecordedClient::default();
        let mut journal = ExecutionJournal::default();
        let ids = journal.plan_batch(
            "deposit:tx1:0",
            vec![
                OperatorCommand::CreditVault { amount: 1 },
                OperatorCommand::Buyback { bnb_amount: 2 },
            ],
        );
        journal.mark_submitted(&ids[0], "0x1").unwrap();
        journal.mark_confirmed(&ids[0]).unwrap();
        let hashes = submit_pending(&mut client, &mut journal).unwrap();
        assert_eq!(hashes, vec!["local-tx-1"]);
        assert_eq!(
            client.submitted,
            vec![OperatorCommand::Buyback { bnb_amount: 2 }]
        );
    }
}
