-- chain_blocks stores the indexer cursor, not every block containing an event.
-- Keep event block metadata denormalized so partially failed scans can persist
-- applied events without accidentally advancing the cursor.

PRAGMA foreign_keys = off;

DROP TABLE IF EXISTS chain_events_no_fk;

CREATE TABLE chain_events_no_fk (
    id           TEXT PRIMARY KEY,
    block_number INTEGER NOT NULL,
    block_hash   TEXT NOT NULL,
    tx_hash      TEXT NOT NULL,
    log_index    INTEGER NOT NULL,
    kind         TEXT NOT NULL,
    payload      TEXT NOT NULL,
    confirmed    INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (tx_hash, log_index)
);

INSERT OR IGNORE INTO chain_events_no_fk
    (id, block_number, block_hash, tx_hash, log_index, kind, payload, confirmed, created_at)
SELECT id, block_number, block_hash, tx_hash, log_index, kind, payload, confirmed, created_at
FROM chain_events;

DROP TABLE chain_events;
ALTER TABLE chain_events_no_fk RENAME TO chain_events;

PRAGMA foreign_keys = on;
