-- Adds metadata to protocol_config_history (block + tx) and a node_history table
-- so that on-chain ProtocolConfigUpdated / NodeUpdated events can be mirrored
-- with full provenance and deduplicated by payload hash.

ALTER TABLE protocol_config_history
    ADD COLUMN IF NOT EXISTS block_number BIGINT,
    ADD COLUMN IF NOT EXISTS tx_hash TEXT,
    ADD COLUMN IF NOT EXISTS payload_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_protocol_config_history_payload_hash
    ON protocol_config_history (payload_hash);

CREATE INDEX IF NOT EXISTS idx_protocol_config_history_tx_hash
    ON protocol_config_history (tx_hash);

CREATE TABLE IF NOT EXISTS node_history (
    id BIGSERIAL PRIMARY KEY,
    node_address TEXT NOT NULL,
    weight BIGINT NOT NULL,
    block_number BIGINT,
    tx_hash TEXT,
    updated_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_node_history_address ON node_history (node_address);
CREATE INDEX IF NOT EXISTS idx_node_history_tx_hash ON node_history (tx_hash);
