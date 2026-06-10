-- D1 (SQLite) port of Token/offchain/migrations/0001 + 0002.
-- Only includes tables the live operator writes: blocks, events, protocol config (+history), node history.
-- Engine ProtocolState + execution journal live inside the OperatorDO (SQLite storage in the DO),
-- mirrored from the Rust JSONB `operator_snapshots`. wei amounts are stored as TEXT decimal strings
-- (SQLite has no NUMERIC(78,0)); parse to bigint in TypeScript.

CREATE TABLE IF NOT EXISTS chain_blocks (
    block_number INTEGER PRIMARY KEY,
    block_hash   TEXT NOT NULL,
    indexed_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chain_events (
    id           TEXT PRIMARY KEY,        -- "{txHash}:{logIndex}"
    block_number INTEGER NOT NULL,
    block_hash   TEXT NOT NULL,
    tx_hash      TEXT NOT NULL,
    log_index    INTEGER NOT NULL,
    kind         TEXT NOT NULL,           -- RefBound | Deposit | TaxCollected
    payload      TEXT NOT NULL,           -- JSON
    confirmed    INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (tx_hash, log_index)
);

CREATE TABLE IF NOT EXISTS protocol_config (
    key        TEXT PRIMARY KEY,
    payload    TEXT NOT NULL,             -- JSON ProtocolConfig
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS protocol_config_history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    key          TEXT NOT NULL,
    payload      TEXT NOT NULL,           -- JSON ProtocolConfig
    updated_by   TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    block_number INTEGER,
    tx_hash      TEXT,
    payload_hash TEXT                      -- keccak256 hex of JSON, used for dedupe
);
CREATE INDEX IF NOT EXISTS idx_config_history_key ON protocol_config_history (key, id DESC);
CREATE INDEX IF NOT EXISTS idx_config_history_tx  ON protocol_config_history (tx_hash);

CREATE TABLE IF NOT EXISTS node_history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    node_address TEXT NOT NULL,
    weight       INTEGER NOT NULL,
    block_number INTEGER,
    tx_hash      TEXT,
    updated_by   TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_node_history_address ON node_history (node_address, id DESC);
CREATE INDEX IF NOT EXISTS idx_node_history_tx      ON node_history (tx_hash);
