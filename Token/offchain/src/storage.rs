use std::collections::BTreeMap;
use std::fmt;
use std::sync::mpsc;

use crate::config::ProtocolConfig;
use crate::journal::ExecutionJournal;
use crate::state::ProtocolState;
use ethers_core::utils::keccak256;
use postgres::{Client, NoTls};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

/// Worker-thread wrapper around the synchronous `postgres::Client`. The sync
/// crate spins up its own internal Tokio runtime and panics with
/// "Cannot start a runtime from within a runtime" if called from inside an
/// async context (our `#[tokio::main]`). Hosting the `Client` on a dedicated
/// std thread and dispatching jobs through a channel keeps the existing
/// synchronous storage API intact while remaining safe to call from async
/// code.
pub struct PgClient {
    sender: mpsc::Sender<Job>,
}

type Job = Box<dyn FnOnce(&mut Client) + Send + 'static>;

impl PgClient {
    pub fn connect(database_url: &str) -> Result<Self, postgres::Error> {
        let url = database_url.to_string();
        let (init_tx, init_rx) = mpsc::channel::<Result<(), postgres::Error>>();
        let (tx, rx) = mpsc::channel::<Job>();
        std::thread::Builder::new()
            .name("uscamex-pg".into())
            .spawn(move || {
                let mut client = match Client::connect(&url, NoTls) {
                    Ok(client) => {
                        let _ = init_tx.send(Ok(()));
                        client
                    }
                    Err(error) => {
                        let _ = init_tx.send(Err(error));
                        return;
                    }
                };
                while let Ok(job) = rx.recv() {
                    job(&mut client);
                }
            })
            .expect("spawn uscamex-pg worker thread");
        init_rx
            .recv()
            .expect("uscamex-pg worker thread terminated before initial reply")?;
        Ok(Self { sender: tx })
    }

    pub fn run<F, R>(&self, f: F) -> R
    where
        F: FnOnce(&mut Client) -> R + Send + 'static,
        R: Send + 'static,
    {
        let (tx, rx) = mpsc::channel::<R>();
        let job: Job = Box::new(move |client| {
            let _ = tx.send(f(client));
        });
        self.sender
            .send(job)
            .expect("uscamex-pg worker thread closed");
        rx.recv()
            .expect("uscamex-pg worker thread dropped reply channel")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConfigHistoryEntry {
    pub id: i64,
    pub payload: ProtocolConfig,
    pub updated_by: String,
    pub created_at: String,
    pub block_number: Option<i64>,
    pub tx_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeHistoryEntry {
    pub id: i64,
    pub node_address: String,
    pub weight: i64,
    pub block_number: Option<i64>,
    pub tx_hash: Option<String>,
    pub updated_by: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredEvent {
    pub id: String,
    pub block_number: u64,
    pub block_hash: String,
    pub tx_hash: String,
    pub log_index: u32,
    pub kind: String,
    pub payload: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredBlock {
    pub number: u64,
    pub hash: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DatabaseSnapshot {
    pub state: Option<ProtocolState>,
    pub journal: ExecutionJournal,
    pub events: BTreeMap<String, StoredEvent>,
    pub blocks: BTreeMap<u64, StoredBlock>,
}

pub trait OperatorDatabase {
    fn load_state(&self) -> Option<ProtocolState>;
    fn save_state(&mut self, state: &ProtocolState);
    fn load_journal(&self) -> ExecutionJournal;
    fn save_journal(&mut self, journal: &ExecutionJournal);
    fn insert_event(&mut self, event: StoredEvent) -> bool;
    fn contains_event(&self, id: &str) -> bool;
    fn record_block(&mut self, block: StoredBlock);
    fn last_indexed_block(&self) -> Option<StoredBlock>;
    fn is_reorg(&self, block_number: u64, observed_hash: &str) -> bool;
    /// Persist a protocol-config snapshot. Implementations may dedupe by
    /// payload hash. Returns true when a new history row was inserted.
    fn record_protocol_config(
        &mut self,
        _config: &ProtocolConfig,
        _updated_by: &str,
        _block_number: Option<u64>,
        _tx_hash: Option<&str>,
    ) -> bool {
        false
    }
    /// Persist a node weight change. Returns true when a new history row was
    /// inserted (implementations may dedupe by tx_hash + node + weight).
    fn record_node_update(
        &mut self,
        _node_address: &str,
        _weight: u32,
        _updated_by: &str,
        _block_number: Option<u64>,
        _tx_hash: Option<&str>,
    ) -> bool {
        false
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MemoryDatabase {
    snapshot: DatabaseSnapshot,
}

impl MemoryDatabase {
    pub fn from_snapshot(snapshot: DatabaseSnapshot) -> Self {
        Self { snapshot }
    }

    pub fn snapshot(&self) -> DatabaseSnapshot {
        self.snapshot.clone()
    }
}

impl OperatorDatabase for MemoryDatabase {
    fn load_state(&self) -> Option<ProtocolState> {
        self.snapshot.state.clone()
    }

    fn save_state(&mut self, state: &ProtocolState) {
        self.snapshot.state = Some(state.clone());
    }

    fn load_journal(&self) -> ExecutionJournal {
        self.snapshot.journal.clone()
    }

    fn save_journal(&mut self, journal: &ExecutionJournal) {
        self.snapshot.journal = journal.clone();
    }

    fn insert_event(&mut self, event: StoredEvent) -> bool {
        self.snapshot
            .events
            .insert(event.id.clone(), event)
            .is_none()
    }

    fn contains_event(&self, id: &str) -> bool {
        self.snapshot.events.contains_key(id)
    }

    fn record_block(&mut self, block: StoredBlock) {
        self.snapshot.blocks.insert(block.number, block);
    }

    fn last_indexed_block(&self) -> Option<StoredBlock> {
        self.snapshot
            .blocks
            .last_key_value()
            .map(|(_, block)| block.clone())
    }

    fn is_reorg(&self, block_number: u64, observed_hash: &str) -> bool {
        self.snapshot
            .blocks
            .get(&block_number)
            .map(|block| block.hash != observed_hash)
            .unwrap_or(false)
    }
}

#[derive(Debug)]
pub enum PostgresStorageError {
    Database(postgres::Error),
    Json(serde_json::Error),
    IntegerOutOfRange,
    Config(String),
}

impl fmt::Display for PostgresStorageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl std::error::Error for PostgresStorageError {}

impl From<postgres::Error> for PostgresStorageError {
    fn from(error: postgres::Error) -> Self {
        Self::Database(error)
    }
}

impl From<serde_json::Error> for PostgresStorageError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

pub struct PostgresDatabase {
    client: PgClient,
}

impl fmt::Debug for PostgresDatabase {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PostgresDatabase")
            .finish_non_exhaustive()
    }
}

impl PostgresDatabase {
    pub fn connect(database_url: &str) -> Result<Self, postgres::Error> {
        Ok(Self {
            client: PgClient::connect(database_url)?,
        })
    }

    pub fn run_migrations(&self) -> Result<(), postgres::Error> {
        self.client.run(|client| -> Result<(), postgres::Error> {
            client.batch_execute(include_str!("../migrations/0001_operator_schema.sql"))?;
            client.batch_execute(include_str!("../migrations/0002_config_history_meta.sql"))?;
            Ok(())
        })
    }

    pub fn try_save_protocol_config(
        &self,
        config: &ProtocolConfig,
        updated_by: &str,
    ) -> Result<bool, PostgresStorageError> {
        self.try_save_protocol_config_with_meta(config, updated_by, None, None)
    }

    /// Persist `protocol_config` (current row) and append a history entry when
    /// the payload differs from the most recent one for the same `tx_hash`
    /// (chain-event mirroring) or when no row with the same payload hash
    /// exists yet (periodic resync). Returns true when a history row is
    /// actually inserted.
    pub fn try_save_protocol_config_with_meta(
        &self,
        config: &ProtocolConfig,
        updated_by: &str,
        block_number: Option<u64>,
        tx_hash: Option<&str>,
    ) -> Result<bool, PostgresStorageError> {
        config
            .validate()
            .map_err(|error| PostgresStorageError::Config(error.to_string()))?;
        let payload = serde_json::to_string(config)?;
        let payload_value: serde_json::Value = serde_json::from_str(&payload)?;
        let payload_hash = config_payload_hash(&payload);
        let block_number_i64 = match block_number {
            Some(value) => Some(to_i64(value)?),
            None => None,
        };
        let updated_by = updated_by.to_string();
        let tx_hash_lower = tx_hash.map(|value| value.to_ascii_lowercase());
        self.client
            .run(move |client| -> Result<bool, PostgresStorageError> {
                let mut transaction = client.transaction()?;
                transaction.execute(
                    "INSERT INTO protocol_config (key, payload, updated_by) VALUES ('current', $1, $2) \
                     ON CONFLICT (key) DO UPDATE SET payload = EXCLUDED.payload, updated_by = EXCLUDED.updated_by, updated_at = now()",
                    &[&payload_value, &updated_by],
                )?;
                let last = transaction.query_opt(
                    "SELECT payload_hash, tx_hash FROM protocol_config_history ORDER BY id DESC LIMIT 1",
                    &[],
                )?;
                let mut should_insert = true;
                if let Some(row) = last {
                    let last_hash: Option<String> = row.get(0);
                    let last_tx: Option<String> = row.get(1);
                    if last_hash.as_deref() == Some(&payload_hash) {
                        if tx_hash_lower.is_none() || tx_hash_lower == last_tx {
                            should_insert = false;
                        }
                    }
                }
                let inserted = if should_insert {
                    transaction.execute(
                        "INSERT INTO protocol_config_history (key, payload, updated_by, block_number, tx_hash, payload_hash) \
                         VALUES ('current', $1, $2, $3, $4, $5)",
                        &[
                            &payload_value,
                            &updated_by,
                            &block_number_i64,
                            &tx_hash_lower,
                            &payload_hash,
                        ],
                    )?;
                    true
                } else {
                    false
                };
                transaction.commit()?;
                Ok(inserted)
            })
    }

    /// Append a node weight change. Returns true when a new history row was
    /// written. Skips inserts that match the most recent row for the same
    /// node + weight + tx_hash to keep the history compact when periodic
    /// scans rebuild the same state.
    pub fn try_record_node_update(
        &self,
        node_address: &str,
        weight: u32,
        updated_by: &str,
        block_number: Option<u64>,
        tx_hash: Option<&str>,
    ) -> Result<bool, PostgresStorageError> {
        let address = node_address.to_ascii_lowercase();
        let weight_i64 = i64::from(weight);
        let block_number_i64 = match block_number {
            Some(value) => Some(to_i64(value)?),
            None => None,
        };
        let tx_value = tx_hash.map(|value| value.to_ascii_lowercase());
        let updated_by = updated_by.to_string();
        self.client
            .run(move |client| -> Result<bool, PostgresStorageError> {
                let last = client.query_opt(
                    "SELECT weight, tx_hash FROM node_history WHERE node_address = $1 ORDER BY id DESC LIMIT 1",
                    &[&address],
                )?;
                if let Some(row) = last {
                    let last_weight: i64 = row.get(0);
                    let last_tx: Option<String> = row.get(1);
                    if last_weight == weight_i64 && last_tx == tx_value {
                        return Ok(false);
                    }
                }
                client.execute(
                    "INSERT INTO node_history (node_address, weight, block_number, tx_hash, updated_by) \
                     VALUES ($1, $2, $3, $4, $5)",
                    &[
                        &address,
                        &weight_i64,
                        &block_number_i64,
                        &tx_value,
                        &updated_by,
                    ],
                )?;
                Ok(true)
            })
    }

    pub fn try_load_node_history(
        &self,
        limit: i64,
    ) -> Result<Vec<NodeHistoryEntry>, PostgresStorageError> {
        let rows = self.client.run(move |client| {
            client.query(
                "SELECT id, node_address, weight, block_number, tx_hash, updated_by, created_at::text \
                 FROM node_history ORDER BY id DESC LIMIT $1",
                &[&limit],
            )
        })?;
        Ok(rows
            .into_iter()
            .map(|row| NodeHistoryEntry {
                id: row.get(0),
                node_address: row.get(1),
                weight: row.get(2),
                block_number: row.get(3),
                tx_hash: row.get(4),
                updated_by: row.get(5),
                created_at: row.get(6),
            })
            .collect())
    }

    pub fn try_load_state(&self) -> Result<Option<ProtocolState>, PostgresStorageError> {
        self.load_snapshot("protocol_state")
    }

    pub fn try_save_state(&self, state: &ProtocolState) -> Result<(), PostgresStorageError> {
        self.save_snapshot("protocol_state", state)
    }

    pub fn try_load_journal(&self) -> Result<ExecutionJournal, PostgresStorageError> {
        Ok(self.load_snapshot("execution_journal")?.unwrap_or_default())
    }

    pub fn try_load_protocol_config_history(
        &self,
        limit: i64,
    ) -> Result<Vec<ConfigHistoryEntry>, PostgresStorageError> {
        let rows = self.client.run(move |client| {
            client.query(
                "SELECT id, payload::text, updated_by, created_at::text, block_number, tx_hash \
                 FROM protocol_config_history ORDER BY id DESC LIMIT $1",
                &[&limit],
            )
        })?;
        rows.into_iter()
            .map(|row| {
                let payload: String = row.get(1);
                let config: ProtocolConfig = serde_json::from_str(&payload)?;
                Ok(ConfigHistoryEntry {
                    id: row.get(0),
                    payload: config,
                    updated_by: row.get(2),
                    created_at: row.get(3),
                    block_number: row.get(4),
                    tx_hash: row.get(5),
                })
            })
            .collect()
    }

    pub fn try_save_journal(&self, journal: &ExecutionJournal) -> Result<(), PostgresStorageError> {
        self.save_snapshot("execution_journal", journal)
    }

    pub fn try_insert_event(&self, event: StoredEvent) -> Result<bool, PostgresStorageError> {
        let block_number = to_i64(event.block_number)?;
        let log_index =
            i32::try_from(event.log_index).map_err(|_| PostgresStorageError::IntegerOutOfRange)?;
        let payload_value: serde_json::Value = serde_json::from_str(&event.payload)?;
        self.client
            .run(move |client| -> Result<bool, PostgresStorageError> {
                let mut transaction = client.transaction()?;
                transaction.execute(
                    "INSERT INTO chain_blocks (block_number, block_hash) VALUES ($1, $2) ON CONFLICT DO NOTHING",
                    &[&block_number, &event.block_hash],
                )?;
                let inserted = transaction.execute(
                    "INSERT INTO chain_events (id, block_number, block_hash, tx_hash, log_index, kind, payload) \
                     VALUES ($1, $2, $3, $4, $5, $6, $7) \
                     ON CONFLICT DO NOTHING",
                    &[
                        &event.id,
                        &block_number,
                        &event.block_hash,
                        &event.tx_hash,
                        &log_index,
                        &event.kind,
                        &payload_value,
                    ],
                )?;
                transaction.commit()?;
                Ok(inserted == 1)
            })
    }

    pub fn try_contains_event(&self, id: &str) -> Result<bool, PostgresStorageError> {
        let id = id.to_string();
        let row = self.client.run(move |client| {
            client.query_one(
                "SELECT EXISTS (SELECT 1 FROM chain_events WHERE id = $1)",
                &[&id],
            )
        })?;
        Ok(row.get(0))
    }

    pub fn try_record_block(&self, block: StoredBlock) -> Result<(), PostgresStorageError> {
        let block_number = to_i64(block.number)?;
        self.client.run(move |client| {
            client.execute(
                "INSERT INTO chain_blocks (block_number, block_hash) VALUES ($1, $2) \
                 ON CONFLICT (block_number) DO UPDATE SET block_hash = EXCLUDED.block_hash, indexed_at = now()",
                &[&block_number, &block.hash],
            )
        })?;
        Ok(())
    }

    pub fn try_last_indexed_block(&self) -> Result<Option<StoredBlock>, PostgresStorageError> {
        let row = self.client.run(|client| {
            client.query_opt(
                "SELECT block_number, block_hash FROM chain_blocks ORDER BY block_number DESC LIMIT 1",
                &[],
            )
        })?;
        row.map(|row| {
            let number = row.get::<_, i64>(0);
            Ok(StoredBlock {
                number: u64::try_from(number)
                    .map_err(|_| PostgresStorageError::IntegerOutOfRange)?,
                hash: row.get(1),
            })
        })
        .transpose()
    }

    pub fn try_is_reorg(
        &self,
        block_number: u64,
        observed_hash: &str,
    ) -> Result<bool, PostgresStorageError> {
        let block_number = to_i64(block_number)?;
        let observed_hash = observed_hash.to_string();
        let row = self.client.run(move |client| {
            client.query_opt(
                "SELECT block_hash FROM chain_blocks WHERE block_number = $1",
                &[&block_number],
            )
        })?;
        Ok(row
            .map(|row| row.get::<_, String>(0) != observed_hash)
            .unwrap_or(false))
    }

    fn load_snapshot<T: DeserializeOwned>(
        &self,
        key: &str,
    ) -> Result<Option<T>, PostgresStorageError> {
        let key = key.to_string();
        let row = self.client.run(move |client| {
            client.query_opt(
                "SELECT payload::text FROM operator_snapshots WHERE key = $1",
                &[&key],
            )
        })?;
        row.map(|row| serde_json::from_str(&row.get::<_, String>(0)))
            .transpose()
            .map_err(PostgresStorageError::Json)
    }

    fn save_snapshot<T: Serialize>(
        &self,
        key: &str,
        value: &T,
    ) -> Result<(), PostgresStorageError> {
        let payload = serde_json::to_value(value)?;
        let key = key.to_string();
        self.client.run(move |client| {
            client.execute(
                "INSERT INTO operator_snapshots (key, payload) VALUES ($1, $2) \
                 ON CONFLICT (key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()",
                &[&key, &payload],
            )
        })?;
        Ok(())
    }
}

impl OperatorDatabase for PostgresDatabase {
    fn load_state(&self) -> Option<ProtocolState> {
        self.try_load_state()
            .expect("load protocol state from postgres")
    }

    fn save_state(&mut self, state: &ProtocolState) {
        self.try_save_state(state)
            .expect("save protocol state to postgres");
    }

    fn load_journal(&self) -> ExecutionJournal {
        self.try_load_journal()
            .expect("load execution journal from postgres")
    }

    fn save_journal(&mut self, journal: &ExecutionJournal) {
        self.try_save_journal(journal)
            .expect("save execution journal to postgres");
    }

    fn insert_event(&mut self, event: StoredEvent) -> bool {
        self.try_insert_event(event)
            .expect("insert chain event into postgres")
    }

    fn contains_event(&self, id: &str) -> bool {
        self.try_contains_event(id)
            .expect("check chain event in postgres")
    }

    fn record_block(&mut self, block: StoredBlock) {
        self.try_record_block(block)
            .expect("record indexed block in postgres");
    }

    fn last_indexed_block(&self) -> Option<StoredBlock> {
        self.try_last_indexed_block()
            .expect("load last indexed block from postgres")
    }

    fn is_reorg(&self, block_number: u64, observed_hash: &str) -> bool {
        self.try_is_reorg(block_number, observed_hash)
            .expect("check indexed block reorg in postgres")
    }

    fn record_protocol_config(
        &mut self,
        config: &ProtocolConfig,
        updated_by: &str,
        block_number: Option<u64>,
        tx_hash: Option<&str>,
    ) -> bool {
        self.try_save_protocol_config_with_meta(config, updated_by, block_number, tx_hash)
            .expect("persist protocol config history in postgres")
    }

    fn record_node_update(
        &mut self,
        node_address: &str,
        weight: u32,
        updated_by: &str,
        block_number: Option<u64>,
        tx_hash: Option<&str>,
    ) -> bool {
        self.try_record_node_update(node_address, weight, updated_by, block_number, tx_hash)
            .expect("persist node history in postgres")
    }
}

fn to_i64(value: u64) -> Result<i64, PostgresStorageError> {
    i64::try_from(value).map_err(|_| PostgresStorageError::IntegerOutOfRange)
}

fn config_payload_hash(payload: &str) -> String {
    let digest = keccak256(payload.as_bytes());
    let mut output = String::with_capacity(64);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for byte in digest {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chain::{submit_pending, RecordedClient};
    use crate::config::BNB;
    use crate::executor::OperatorCommand;
    use crate::journal::ExecutionJournal;
    use crate::state::ProtocolState;

    #[test]
    fn database_snapshot_survives_operator_restart() {
        let mut state = ProtocolState::new("root");
        state.ensure_user_mut("alice").principal_bnb = BNB;
        let mut journal = ExecutionJournal::default();
        let ids = journal.plan_batch(
            "deposit:0xaaa:0",
            vec![
                OperatorCommand::CreditVault { amount: BNB / 10 },
                OperatorCommand::TransferBnb {
                    to: "root".into(),
                    amount: BNB / 10,
                    reason: "direct-referral".into(),
                },
            ],
        );
        journal.mark_submitted(&ids[0], "0x1").unwrap();
        journal.mark_confirmed(&ids[0]).unwrap();

        let mut database = MemoryDatabase::default();
        database.save_state(&state);
        database.save_journal(&journal);
        assert!(database.insert_event(StoredEvent {
            id: "0xaaa:0".into(),
            block_number: 100,
            block_hash: "0xblock".into(),
            tx_hash: "0xaaa".into(),
            log_index: 0,
            kind: "Deposit".into(),
            payload: "{\"user\":\"alice\",\"amount\":\"1000000000000000000\"}".into(),
        }));

        let mut restarted = MemoryDatabase::from_snapshot(database.snapshot());
        let restored_state = restarted.load_state().unwrap();
        let mut restored_journal = restarted.load_journal();
        assert_eq!(restored_state.user("alice").unwrap().principal_bnb, BNB);
        assert!(restarted.contains_event("0xaaa:0"));

        let mut client = RecordedClient::default();
        let hashes = submit_pending(&mut client, &mut restored_journal).unwrap();
        assert_eq!(hashes, vec!["local-tx-1"]);
        assert_eq!(client.submitted.len(), 1);
        restarted.save_journal(&restored_journal);
    }

    #[test]
    fn database_detects_indexed_block_reorg() {
        let mut database = MemoryDatabase::default();
        database.record_block(StoredBlock {
            number: 100,
            hash: "0xaaa".into(),
        });
        assert_eq!(
            database.last_indexed_block(),
            Some(StoredBlock {
                number: 100,
                hash: "0xaaa".into(),
            })
        );
        assert!(!database.is_reorg(100, "0xaaa"));
        assert!(database.is_reorg(100, "0xbbb"));
        assert!(!database.is_reorg(101, "0xccc"));
    }

    #[test]
    fn state_and_journal_are_json_roundtrippable_for_postgres_snapshots() {
        let mut state = ProtocolState::new("root");
        state.ensure_user_mut("alice").principal_bnb = BNB;
        let state_json = serde_json::to_string(&state).unwrap();
        let restored_state: ProtocolState = serde_json::from_str(&state_json).unwrap();
        assert_eq!(restored_state.user("alice").unwrap().principal_bnb, BNB);

        let mut journal = ExecutionJournal::default();
        journal.plan_batch(
            "deposit:0xaaa:0",
            vec![OperatorCommand::TransferBnb {
                to: "root".into(),
                amount: BNB / 10,
                reason: "direct-referral".into(),
            }],
        );
        let journal_json = serde_json::to_string(&journal).unwrap();
        let restored_journal: ExecutionJournal = serde_json::from_str(&journal_json).unwrap();
        assert_eq!(restored_journal.records.len(), 1);
    }
}
