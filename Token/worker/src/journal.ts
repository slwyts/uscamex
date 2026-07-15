/**
 * Idempotent command journal. Port of Token/offchain/src/journal.rs.
 * Records are keyed by id, but execution order follows the source chain event
 * order when available. This avoids tx-hash lexical ordering changing referral
 * outcomes when many deposits arrive close together.
 * Lives inside OperatorDO; serialized to DO storage.
 */
import { commandKind, type OperatorCommand } from "./executor";

const MAX_ATTEMPTS = 3;
const TRANSIENT_MAX_ATTEMPTS = 8;

export type CommandStatus =
  | { state: "Pending" }
  | { state: "Submitted"; txHash: string }
  | { state: "Confirmed"; txHash: string }
  | { state: "Failed"; error: string };

export interface CommandRecord {
  id: string;
  command: OperatorCommand;
  attempts: number;
  status: CommandStatus;
  order?: CommandOrder;
}

export interface CommandOrder {
  blockNumber: bigint;
  logIndex: number;
  sequence: number;
}

export interface CommandOrderInput {
  blockNumber: bigint;
  logIndex: number;
}

export type JournalErrorKind = "MissingCommand" | "AlreadyConfirmed";

export class JournalError extends Error {
  constructor(public kind: JournalErrorKind) {
    super(kind);
  }
}

export class ExecutionJournal {
  records = new Map<string, CommandRecord>();

  recordsInExecutionOrder(): CommandRecord[] {
    return [...this.records.values()].sort(compareRecords);
  }

  /** journal.rs:34 — id = "{batchKey}:{index}:{kind}", or_insert => replanning is a no-op. */
  planBatch(batchKey: string, commands: OperatorCommand[], order?: CommandOrderInput): string[] {
    return commands.map((command, index) => {
      const id = `${batchKey}:${index}:${commandKind(command)}`;
      if (!this.records.has(id)) {
        this.records.set(id, {
          id,
          command,
          attempts: 0,
          status: { state: "Pending" },
          order: order ? { ...order, sequence: index } : undefined,
        });
      }
      return id;
    });
  }

  pendingCommands(): [string, OperatorCommand][] {
    return this.recordsInExecutionOrder()
      .filter((r) => r.status.state === "Pending")
      .map((r) => [r.id, r.command]);
  }

  /**
   * RedeemUserLp is the final command in a deposit/settlement batch and depends
   * on the payouts before it. A failed prerequisite must never be skipped over:
   * otherwise LP could be redeemed even though the reward that triggered the
   * exit never reached the user.
   */
  priorBatchCommandsConfirmed(id: string): boolean {
    const target = parseRecordId(id);
    if (!target) return true;
    for (const record of this.records.values()) {
      const parsed = parseRecordId(record.id);
      if (!parsed || parsed.batchKey !== target.batchKey || parsed.index >= target.index) continue;
      if (record.status.state !== "Confirmed") return false;
    }
    return true;
  }

  /**
   * The latest confirmed transaction earlier in the same batch is a safe lower
   * bound for redeem-event reconciliation: this command cannot have executed
   * before its prerequisites. Keeping the search window tight also avoids RPC
   * providers' historical eth_getLogs range limits.
   */
  priorBatchConfirmedTxHash(id: string): string | null {
    const target = parseRecordId(id);
    if (!target) return null;
    let best: { index: number; txHash: string } | null = null;
    for (const record of this.records.values()) {
      const parsed = parseRecordId(record.id);
      if (!parsed || parsed.batchKey !== target.batchKey || parsed.index >= target.index) continue;
      if (record.status.state !== "Confirmed" || !/^0x[0-9a-fA-F]{64}$/.test(record.status.txHash)) continue;
      if (!best || parsed.index > best.index) best = { index: parsed.index, txHash: record.status.txHash };
    }
    return best?.txHash.toLowerCase() ?? null;
  }

  markSubmitted(id: string, txHash: string): void {
    const record = this.records.get(id);
    if (!record) throw new JournalError("MissingCommand");
    if (record.status.state === "Confirmed") throw new JournalError("AlreadyConfirmed");
    record.attempts += 1;
    record.status = { state: "Submitted", txHash };
  }

  markConfirmed(id: string, txHashOverride?: string): void {
    const record = this.records.get(id);
    if (!record) throw new JournalError("MissingCommand");
    let txHash = txHashOverride ?? "";
    if (!txHash && (record.status.state === "Submitted" || record.status.state === "Confirmed")) {
      txHash = record.status.txHash;
    }
    record.status = { state: "Confirmed", txHash };
  }

  markFailed(id: string, error: string): void {
    const record = this.records.get(id);
    if (!record) throw new JournalError("MissingCommand");
    if (record.status.state === "Confirmed") throw new JournalError("AlreadyConfirmed");
    record.attempts += 1;
    record.status = { state: "Failed", error };
  }

  canRetry(id: string, error?: string): boolean {
    const record = this.records.get(id);
    if (!record) return false;
    return record.attempts < maxAttempts(error);
  }

  resetToPending(id: string): void {
    const record = this.records.get(id);
    if (!record) throw new JournalError("MissingCommand");
    record.status = { state: "Pending" };
  }

  /** Retry all Failed commands that haven't exceeded MAX_ATTEMPTS. */
  retryFailed(): number {
    let count = 0;
    for (const r of this.records.values()) {
      if (r.status.state === "Failed" && r.attempts < maxAttempts(r.status.error)) {
        r.status = { state: "Pending" };
        count += 1;
      }
    }
    return count;
  }

  confirmedCount(): number {
    return this.recordsInExecutionOrder().filter((r) => r.status.state === "Confirmed").length;
  }

  // ---- (de)serialization (bigint-safe) for DO storage + admin listing ----

  toJSON(): unknown {
    return {
      records: this.recordsInExecutionOrder().map((r) => ({
        id: r.id,
        command: serializeCommand(r.command),
        attempts: r.attempts,
        status: r.status,
        order: r.order ? serializeOrder(r.order) : undefined,
      })),
    };
  }

  static fromJSON(data: {
    records: { id: string; command: unknown; attempts: number; status: CommandStatus; order?: SerializedCommandOrder }[];
  }): ExecutionJournal {
    const journal = new ExecutionJournal();
    for (const r of data.records) {
      journal.records.set(r.id, {
        id: r.id,
        command: deserializeCommand(r.command),
        attempts: r.attempts,
        status: r.status,
        order: r.order ? deserializeOrder(r.order) : undefined,
      });
    }
    return journal;
  }
}

interface SerializedCommandOrder {
  blockNumber: string;
  logIndex: number;
  sequence?: number;
  commandIndex?: number;
}

function serializeOrder(order: CommandOrder): SerializedCommandOrder {
  return {
    blockNumber: order.blockNumber.toString(),
    logIndex: order.logIndex,
    sequence: order.sequence,
  };
}

function deserializeOrder(order: SerializedCommandOrder): CommandOrder {
  return {
    blockNumber: BigInt(order.blockNumber),
    logIndex: order.logIndex,
    sequence: order.sequence ?? order.commandIndex ?? 0,
  };
}

function compareRecords(a: CommandRecord, b: CommandRecord): number {
  if (a.order && b.order) {
    if (a.order.blockNumber !== b.order.blockNumber) return a.order.blockNumber < b.order.blockNumber ? -1 : 1;
    if (a.order.logIndex !== b.order.logIndex) return a.order.logIndex - b.order.logIndex;
    if (a.order.sequence !== b.order.sequence) return a.order.sequence - b.order.sequence;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function parseRecordId(id: string): { batchKey: string; index: number } | null {
  const match = /^(.*):(\d+):[^:]+$/.exec(id);
  if (!match) return null;
  const index = Number(match[2]);
  return Number.isSafeInteger(index) ? { batchKey: match[1], index } : null;
}

function maxAttempts(error?: string): number {
  return error && isTransientSubmitError(error) ? TRANSIENT_MAX_ATTEMPTS : MAX_ATTEMPTS;
}

function isTransientSubmitError(error: string): boolean {
  const msg = error.toLowerCase();
  return (
    msg.includes("replacement transaction underpriced") ||
    msg.includes("transaction underpriced") ||
    msg.includes("nonce too low") ||
    msg.includes("already known") ||
    msg.includes("known transaction") ||
    msg.includes("receiptfailed") ||
    msg.includes("receipttimeout")
  );
}

// bigint fields must round-trip as strings (matched at any nesting depth)
const BIGINT_FIELDS = new Set([
  "bnbAmount",
  "tokenValueBnb",
  "amount",
  "refundBnb",
  "lpTokenAmount",
  "taxTokenAmount",
  "builderTokenAmount",
  "burnTokenAmount",
  // DepositBatch fields (incl. nested nodePayouts[].amount)
  "lpBnb",
  "lpTokenValueBnb",
  "builderBnb",
  "vaultBnb",
  "directBnb",
]);

function serializeValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(serializeValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = serializeValue(v);
    return out;
  }
  return value;
}

function deserializeValue(key: string, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => deserializeValue(key, v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = deserializeValue(k, v);
    return out;
  }
  return BIGINT_FIELDS.has(key) && typeof value === "string" ? BigInt(value) : value;
}

function serializeCommand(command: OperatorCommand): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(command)) {
    out[k] = serializeValue(v);
  }
  return out;
}

function deserializeCommand(raw: unknown): OperatorCommand {
  const obj = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = deserializeValue(k, v);
  }
  return out as unknown as OperatorCommand;
}
