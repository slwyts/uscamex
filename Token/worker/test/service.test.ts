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
  lpBnb: (3n * BNB) / 10n,
  lpTokenValueBnb: (3n * BNB) / 10n,
  builderBnb: BNB / 10n,
  vaultBnb: BNB / 10n,
  directReferrer: "0xa4b76d7cae384c9a5fd5f573cef74bfdb980e966",
  directBnb: BNB / 10n,
  nodePayouts: [],
};

function serviceWith(chain: ChainClient, journal: ExecutionJournal): OperatorService {
  return new OperatorService(
    new Engine(defaultProtocolConfig()),
    new ProtocolState("root"),
    journal,
    { containsEvent: () => false, insertEvent: () => undefined },
    chain,
  );
}

describe("service: submit reconciliation", () => {
  it("marks an already-executed failed DepositBatch as confirmed without resubmitting", async () => {
    const journal = new ExecutionJournal();
    const [id] = journal.planBatch(`deposit:0x${"1".repeat(64)}:46`, [depositBatch]);
    const record = journal.records.get(id)!;
    record.attempts = 5;
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

  it("marks an already-executed failed RedeemUserLp as confirmed without resubmitting", async () => {
    const journal = new ExecutionJournal();
    const [id] = journal.planBatch("static:0xuser:slot", [
      { kind: "RedeemUserLp", user: "0xabc", lpTokenAmount: 123n },
    ]);
    const record = journal.records.get(id)!;
    record.attempts = 5;
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
