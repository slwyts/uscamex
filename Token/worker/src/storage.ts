/**
 * D1 persistence adapter. Port of the live-used parts of Token/offchain/src/storage.rs.
 * Tables: chain_blocks, chain_events, protocol_config(+history), node_history.
 * Engine ProtocolState + journal are NOT here — they live in OperatorDO storage (were JSONB
 * snapshots in Postgres). wei amounts stored as TEXT decimal strings.
 */
import { keccak256, toHex } from "viem";
import type { ProtocolConfig } from "./config";
import { eventKind, eventPayload, type ChainEvent, type IndexedEvent, type TaxSide } from "./indexer";

export interface StoredBlock {
  number: bigint;
  hash: string;
}

interface StoredEventRow {
  id: string;
  block_number: number;
  block_hash: string;
  tx_hash: string;
  log_index: number;
  kind: "RefBound" | "Deposit" | "TaxCollected";
  payload: string;
}

/** keccak256 hex of the config JSON (storage.rs:664 config_payload_hash). */
export function configPayloadHash(config: ProtocolConfig): string {
  const json = JSON.stringify(config, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  return keccak256(toHex(json));
}

export class D1Storage {
  constructor(private db: D1Database) {}

  async insertEvent(event: IndexedEvent): Promise<boolean> {
    const id = event.event.id;
    const res = await this.db
      .prepare(
        `INSERT OR IGNORE INTO chain_events
           (id, block_number, block_hash, tx_hash, log_index, kind, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        Number(event.blockNumber),
        event.blockHash,
        event.txHash,
        event.logIndex,
        eventKind(event.event),
        eventPayload(event.event),
      )
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  async containsEvent(id: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT 1 AS x FROM chain_events WHERE id = ? LIMIT 1")
      .bind(id)
      .first<{ x: number }>();
    return row != null;
  }

  async storedEvents(fromBlock: bigint, toBlock: bigint, limit: number, offset: number): Promise<IndexedEvent[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, block_number, block_hash, tx_hash, log_index, kind, payload
           FROM chain_events
          WHERE block_number >= ? AND block_number <= ?
          ORDER BY block_number, log_index
          LIMIT ? OFFSET ?`,
      )
      .bind(Number(fromBlock), Number(toBlock), limit, offset)
      .all<StoredEventRow>();
    return results.map(storedEventRowToIndexedEvent);
  }

  async recordBlock(block: StoredBlock): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO chain_blocks (block_number, block_hash) VALUES (?, ?)
         ON CONFLICT (block_number) DO UPDATE SET block_hash = excluded.block_hash`,
      )
      .bind(Number(block.number), block.hash)
      .run();
  }

  async lastIndexedBlock(): Promise<StoredBlock | null> {
    const row = await this.db
      .prepare("SELECT block_number, block_hash FROM chain_blocks ORDER BY block_number DESC LIMIT 1")
      .first<{ block_number: number; block_hash: string }>();
    return row ? { number: BigInt(row.block_number), hash: row.block_hash } : null;
  }

  /** True if we recorded this block with a different hash (reorg). */
  async isReorg(blockNumber: bigint, observedHash: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT block_hash FROM chain_blocks WHERE block_number = ?")
      .bind(Number(blockNumber))
      .first<{ block_hash: string }>();
    return row != null && row.block_hash !== observedHash;
  }

  /** storage.rs:284 — upsert current config; append history when hash/tx differ from last. */
  async recordProtocolConfig(
    config: ProtocolConfig,
    updatedBy: string,
    blockNumber: bigint | null,
    txHash: string | null,
  ): Promise<boolean> {
    const payload = JSON.stringify(config, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    const payloadHash = configPayloadHash(config);
    const txLower = txHash ? txHash.toLowerCase() : null;

    await this.db
      .prepare(
        `INSERT INTO protocol_config (key, payload, updated_by) VALUES ('current', ?, ?)
         ON CONFLICT (key) DO UPDATE SET payload = excluded.payload, updated_by = excluded.updated_by, updated_at = datetime('now')`,
      )
      .bind(payload, updatedBy)
      .run();

    const last = await this.db
      .prepare("SELECT payload_hash, tx_hash FROM protocol_config_history ORDER BY id DESC LIMIT 1")
      .first<{ payload_hash: string | null; tx_hash: string | null }>();

    let shouldInsert = true;
    if (last) {
      if (last.payload_hash === payloadHash && (txLower == null || last.tx_hash === txLower)) {
        shouldInsert = false;
      }
    }
    if (!shouldInsert) return false;

    await this.db
      .prepare(
        `INSERT INTO protocol_config_history
           (key, payload, updated_by, block_number, tx_hash, payload_hash)
         VALUES ('current', ?, ?, ?, ?, ?)`,
      )
      .bind(payload, updatedBy, blockNumber == null ? null : Number(blockNumber), txLower, payloadHash)
      .run();
    return true;
  }

  /** storage.rs:350 — append node history; skip when weight+tx match last entry for the node. */
  async recordNodeUpdate(
    nodeAddress: string,
    weight: number,
    updatedBy: string,
    blockNumber: bigint | null,
    txHash: string | null,
  ): Promise<boolean> {
    const addr = nodeAddress.toLowerCase();
    const txLower = txHash ? txHash.toLowerCase() : null;
    const last = await this.db
      .prepare("SELECT weight, tx_hash FROM node_history WHERE node_address = ? ORDER BY id DESC LIMIT 1")
      .bind(addr)
      .first<{ weight: number; tx_hash: string | null }>();
    if (last && last.weight === weight && last.tx_hash === txLower) return false;

    await this.db
      .prepare(
        `INSERT INTO node_history (node_address, weight, block_number, tx_hash, updated_by)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(addr, weight, blockNumber == null ? null : Number(blockNumber), txLower, updatedBy)
      .run();
    return true;
  }
}

function storedEventRowToIndexedEvent(row: StoredEventRow): IndexedEvent {
  const payload = JSON.parse(row.payload) as Record<string, unknown>;
  return {
    blockNumber: BigInt(row.block_number),
    blockHash: row.block_hash,
    txHash: row.tx_hash,
    logIndex: row.log_index,
    event: storedEventFromPayload(row.id, row.kind, payload),
  };
}

function storedEventFromPayload(
  id: string,
  kind: StoredEventRow["kind"],
  payload: Record<string, unknown>,
): ChainEvent {
  switch (kind) {
    case "RefBound":
      return {
        kind,
        id,
        user: stringField(payload, "user"),
        referrer: stringField(payload, "referrer"),
      };
    case "Deposit":
      return {
        kind,
        id,
        user: stringField(payload, "user"),
        amount: BigInt(stringField(payload, "amount")),
      };
    case "TaxCollected":
      return {
        kind,
        id,
        from: stringField(payload, "from"),
        to: stringField(payload, "to"),
        amount: BigInt(stringField(payload, "amount")),
        side: taxSideFromStored(stringField(payload, "side")),
      };
  }
}

function stringField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string") throw new Error(`invalid stored chain event payload: ${key}`);
  return value.toLowerCase();
}

function taxSideFromStored(value: string): TaxSide {
  if (value === "buy") return "Buy";
  if (value === "sell") return "Sell";
  throw new Error(`invalid stored tax side: ${value}`);
}
