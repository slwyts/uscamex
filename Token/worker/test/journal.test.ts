import { describe, it, expect } from "vitest";
import { ExecutionJournal, JournalError } from "../src/journal";
import type { OperatorCommand } from "../src/executor";

const commands: OperatorCommand[] = [
  { kind: "CreditVault", amount: 1n },
  { kind: "TransferBnb", to: "alice", amount: 2n, reason: "direct" },
];

describe("journal idempotency", () => {
  it("batch planning is idempotent; failed commands are manual", () => {
    const journal = new ExecutionJournal();
    const first = journal.planBatch("deposit:tx1:0", commands);
    const second = journal.planBatch("deposit:tx1:0", commands);
    expect(first).toEqual(second);
    expect(journal.records.size).toBe(2);

    journal.markSubmitted(first[0], "0xaaa");
    journal.markConfirmed(first[0]);
    journal.markFailed(first[1], "nonce-too-low");

    expect(journal.pendingCommands().length).toBe(0);
    expect(journal.confirmedCount()).toBe(1);
  });

  it("rejects marking a confirmed command", () => {
    const journal = new ExecutionJournal();
    const [id] = journal.planBatch("b", [{ kind: "CreditVault", amount: 1n }]);
    journal.markSubmitted(id, "0x1");
    journal.markConfirmed(id);
    expect(() => journal.markSubmitted(id, "0x2")).toThrow(JournalError);
  });

  it("round-trips through JSON with bigint commands", () => {
    const journal = new ExecutionJournal();
    journal.planBatch("deposit:tx9:0", [
      { kind: "AddLiquidity", bnbAmount: 10n ** 18n, tokenValueBnb: 5n * 10n ** 17n },
      { kind: "RedeemUserLp", user: "0xabc", lpBnbShare: 3n, totalActivePrincipal: 9n },
    ]);
    const restored = ExecutionJournal.fromJSON(journal.toJSON() as never);
    const pending = restored.pendingCommands();
    expect(pending.length).toBe(2);
    const add = pending.find(([, c]) => c.kind === "AddLiquidity")![1];
    if (add.kind === "AddLiquidity") {
      expect(add.bnbAmount).toBe(10n ** 18n);
      expect(typeof add.bnbAmount).toBe("bigint");
    }
  });
});
