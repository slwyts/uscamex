import { describe, expect, it } from "vitest";
import { BNB, defaultProtocolConfig } from "../src/config";
import { Engine } from "../src/engine";
import type { OperatorCommand } from "../src/executor";
import { ExecutionJournal } from "../src/journal";
import { OperatorService, type ChainClient } from "../src/service";
import { ProtocolState } from "../src/state";

const TX_HASH = `0x${"a".repeat(64)}`;

const depositBatch: OperatorCommand = {
  kind: "DepositBatch",
  user: "0x98c2e0ecdfa961f8b36144c743fea3951dad0309",
  amount: BNB,
  lpBnb: (3n * BNB) / 10n,
  lpTokenValueBnb: (3n * BNB) / 10n,
  builderBnb: BNB / 10n,
  vaultBnb: BNB / 10n,
  directReferrer: "0xa4b76d7cae384c9a5fd5f573cef74bfdb980e966",
  directBnb: BNB / 10n,
  nodePayouts: [],
};

function serviceWith(chain: ChainClient, journal: ExecutionJournal, state = new ProtocolState("root")): OperatorService {
  return new OperatorService(
    new Engine(defaultProtocolConfig()),
    state,
    journal,
    { containsEvent: () => false, insertEvent: () => undefined },
    chain,
  );
}

describe("service: submit reconciliation", () => {
  it("reclaims an already-executed retryable DepositBatch as confirmed without resubmitting", async () => {
    const journal = new ExecutionJournal();
    const [id] = journal.planBatch(`deposit:0x${"1".repeat(64)}:46`, [depositBatch]);
    const record = journal.records.get(id)!;
    record.attempts = 1;
    record.status = { state: "Failed", error: "ReceiptFailed: 0xdead" };

    let submitted = 0;
    const chain: ChainClient = {
      async findConfirmedCommand() {
        return TX_HASH;
      },
      async submit() {
        submitted += 1;
        throw new Error("must not submit");
      },
    };

    const txHashes = await serviceWith(chain, journal).submitPending();
    expect(txHashes).toEqual([TX_HASH]);
    expect(submitted).toBe(0);
    expect(record.status).toEqual({ state: "Confirmed", txHash: TX_HASH });
  });

  it("reclaims an already-executed retryable RedeemUserLp as confirmed without resubmitting", async () => {
    const journal = new ExecutionJournal();
    const [id] = journal.planBatch("static:0xuser:slot", [
      { kind: "RedeemUserLp", user: "0xabc", lpTokenAmount: 123n },
    ]);
    const record = journal.records.get(id)!;
    record.attempts = 1;
    record.status = { state: "Failed", error: "ReceiptFailed: 0xdead" };

    let submitted = 0;
    const chain: ChainClient = {
      async findConfirmedCommand() {
        return TX_HASH;
      },
      async submit() {
        submitted += 1;
        throw new Error("must not submit");
      },
    };

    const txHashes = await serviceWith(chain, journal).submitPending();
    expect(txHashes).toEqual([TX_HASH]);
    expect(submitted).toBe(0);
    expect(record.status).toEqual({ state: "Confirmed", txHash: TX_HASH });
  });
});

describe("service: deposit planning", () => {
  it("does not apply deposit accounting before the batch is confirmed", () => {
    const state = new ProtocolState("root");
    const journal = new ExecutionJournal();
    const service = serviceWith({ async submit() { return TX_HASH; } }, journal, state);

    service.processEvent({ blockNumber: 1n, blockHash: "0x1", txHash: "0x1", logIndex: 0, event: { kind: "RefBound", id: "0x1:0", user: "alice", referrer: "root" } });
    service.processEvent({ blockNumber: 1n, blockHash: "0x1", txHash: "0x1", logIndex: 1, event: { kind: "Deposit", id: "0x1:1", user: "alice", amount: BNB } });

    expect(state.user("alice")!.principalBnb).toBe(0n);
    expect(journal.pendingCommands()).toHaveLength(1);
    expect(journal.pendingCommands()[0][1]).toMatchObject({ kind: "DepositBatch", user: "alice", amount: BNB });
  });

  it("uses pending deposits for later allocation planning in the same scan", () => {
    const state = new ProtocolState("root");
    const journal = new ExecutionJournal();
    const service = serviceWith({ async submit() { return TX_HASH; } }, journal, state);

    service.processEvent({ blockNumber: 1n, blockHash: "0x1", txHash: "0x1", logIndex: 0, event: { kind: "RefBound", id: "0x1:0", user: "alice", referrer: "root" } });
    service.processEvent({ blockNumber: 1n, blockHash: "0x1", txHash: "0x1", logIndex: 1, event: { kind: "Deposit", id: "0x1:1", user: "alice", amount: BNB } });
    service.processEvent({ blockNumber: 1n, blockHash: "0x1", txHash: "0x1", logIndex: 2, event: { kind: "RefBound", id: "0x1:2", user: "bob", referrer: "alice" } });
    service.processEvent({ blockNumber: 1n, blockHash: "0x1", txHash: "0x1", logIndex: 3, event: { kind: "Deposit", id: "0x1:3", user: "bob", amount: BNB } });

    const bobBatch = journal.pendingCommands().map(([, command]) => command).find((command) => command.kind === "DepositBatch" && command.user === "bob");
    expect(bobBatch).toMatchObject({ directReferrer: "alice", directBnb: BNB / 10n });
    expect(state.user("alice")!.principalBnb).toBe(0n);
  });
});
