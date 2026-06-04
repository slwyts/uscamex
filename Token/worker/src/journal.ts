/**
 * Idempotent command journal. Port of Token/offchain/src/journal.rs.
 * Records keyed by id; iteration is sorted by id to match Rust's BTreeMap ordering.
 * Lives inside OperatorDO; serialized to DO storage.
 */
import { commandKind, type OperatorCommand } from "./executor";

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
}

export type JournalErrorKind = "MissingCommand" | "AlreadyConfirmed";

export class JournalError extends Error {
  constructor(public kind: JournalErrorKind) {
    super(kind);
  }
}

export class ExecutionJournal {
  records = new Map<string, CommandRecord>();

  private sortedRecords(): CommandRecord[] {
    return [...this.records.keys()].sort().map((k) => this.records.get(k)!);
  }

  /** journal.rs:34 — id = "{batchKey}:{index}:{kind}", or_insert => replanning is a no-op. */
  planBatch(batchKey: string, commands: OperatorCommand[]): string[] {
    return commands.map((command, index) => {
      const id = `${batchKey}:${index}:${commandKind(command)}`;
      if (!this.records.has(id)) {
        this.records.set(id, { id, command, attempts: 0, status: { state: "Pending" } });
      }
      return id;
    });
  }

  pendingCommands(): [string, OperatorCommand][] {
    return this.sortedRecords()
      .filter((r) => r.status.state === "Pending")
      .map((r) => [r.id, r.command]);
  }

  markSubmitted(id: string, txHash: string): void {
    const record = this.records.get(id);
    if (!record) throw new JournalError("MissingCommand");
    if (record.status.state === "Confirmed") throw new JournalError("AlreadyConfirmed");
    record.attempts += 1;
    record.status = { state: "Submitted", txHash };
  }

  markConfirmed(id: string): void {
    const record = this.records.get(id);
    if (!record) throw new JournalError("MissingCommand");
    const txHash =
      record.status.state === "Submitted" || record.status.state === "Confirmed"
        ? record.status.txHash
        : "";
    record.status = { state: "Confirmed", txHash };
  }

  markFailed(id: string, error: string): void {
    const record = this.records.get(id);
    if (!record) throw new JournalError("MissingCommand");
    if (record.status.state === "Confirmed") throw new JournalError("AlreadyConfirmed");
    record.status = { state: "Failed", error };
  }

  confirmedCount(): number {
    return this.sortedRecords().filter((r) => r.status.state === "Confirmed").length;
  }

  // ---- (de)serialization (bigint-safe) for DO storage + admin listing ----

  toJSON(): unknown {
    return {
      records: this.sortedRecords().map((r) => ({
        id: r.id,
        command: serializeCommand(r.command),
        attempts: r.attempts,
        status: r.status,
      })),
    };
  }

  static fromJSON(data: {
    records: { id: string; command: unknown; attempts: number; status: CommandStatus }[];
  }): ExecutionJournal {
    const journal = new ExecutionJournal();
    for (const r of data.records) {
      journal.records.set(r.id, {
        id: r.id,
        command: deserializeCommand(r.command),
        attempts: r.attempts,
        status: r.status,
      });
    }
    return journal;
  }
}

// bigint fields must round-trip as strings
const BIGINT_FIELDS = new Set([
  "bnbAmount",
  "tokenValueBnb",
  "amount",
  "refundBnb",
  "lpBnbShare",
  "totalActivePrincipal",
  "taxTokenAmount",
  "builderTokenAmount",
  "burnTokenAmount",
]);

function serializeCommand(command: OperatorCommand): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(command)) {
    out[k] = typeof v === "bigint" ? v.toString() : v;
  }
  return out;
}

function deserializeCommand(raw: unknown): OperatorCommand {
  const obj = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = BIGINT_FIELDS.has(k) && typeof v === "string" ? BigInt(v) : v;
  }
  return out as unknown as OperatorCommand;
}
