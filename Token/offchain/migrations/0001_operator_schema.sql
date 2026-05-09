CREATE TABLE IF NOT EXISTS chain_blocks (
    block_number BIGINT PRIMARY KEY,
    block_hash TEXT NOT NULL,
    indexed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chain_events (
    id TEXT PRIMARY KEY,
    block_number BIGINT NOT NULL REFERENCES chain_blocks(block_number),
    block_hash TEXT NOT NULL,
    tx_hash TEXT NOT NULL,
    log_index INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload JSONB NOT NULL,
    confirmed BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tx_hash, log_index)
);

CREATE TABLE IF NOT EXISTS users (
    address TEXT PRIMARY KEY,
    referrer TEXT,
    direct_count INTEGER NOT NULL DEFAULT 0,
    bound_block BIGINT,
    bound_tx_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS positions (
    id BIGSERIAL PRIMARY KEY,
    user_address TEXT NOT NULL REFERENCES users(address),
    position_id BIGINT NOT NULL,
    principal_bnb NUMERIC(78, 0) NOT NULL,
    static_paid_bnb NUMERIC(78, 0) NOT NULL DEFAULT 0,
    dynamic_paid_bnb NUMERIC(78, 0) NOT NULL DEFAULT 0,
    active BOOLEAN NOT NULL DEFAULT true,
    exited BOOLEAN NOT NULL DEFAULT false,
    exit_reason TEXT,
    deposit_event_id TEXT REFERENCES chain_events(id),
    opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at TIMESTAMPTZ,
    UNIQUE (user_address, position_id)
);

CREATE TABLE IF NOT EXISTS settlement_periods (
    id TEXT PRIMARY KEY,
    user_address TEXT NOT NULL REFERENCES users(address),
    position_id BIGINT NOT NULL,
    period_key TEXT NOT NULL,
    static_bnb NUMERIC(78, 0) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_address, position_id, period_key)
);

CREATE TABLE IF NOT EXISTS execution_commands (
    id TEXT PRIMARY KEY,
    batch_key TEXT NOT NULL,
    command_index INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload JSONB NOT NULL,
    status TEXT NOT NULL,
    tx_hash TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (batch_key, command_index, kind)
);

CREATE TABLE IF NOT EXISTS config_snapshots (
    id BIGSERIAL PRIMARY KEY,
    enabled_block BIGINT NOT NULL,
    operator TEXT NOT NULL,
    payload JSONB NOT NULL,
    tx_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS protocol_config (
    key TEXT PRIMARY KEY,
    payload JSONB NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS protocol_config_history (
    id BIGSERIAL PRIMARY KEY,
    key TEXT NOT NULL,
    payload JSONB NOT NULL,
    updated_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS health_snapshots (
    id BIGSERIAL PRIMARY KEY,
    block_number BIGINT NOT NULL,
    operator_bnb NUMERIC(78, 0) NOT NULL,
    pair_token_reserve NUMERIC(78, 0) NOT NULL,
    pair_bnb_reserve NUMERIC(78, 0) NOT NULL,
    pending_commands INTEGER NOT NULL,
    alerts JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS operator_snapshots (
    key TEXT PRIMARY KEY,
    payload JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
