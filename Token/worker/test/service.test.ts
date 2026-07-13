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

function depositCommand(user: string, directReferrer: string | null): Extract<OperatorCommand, { kind: "DepositBatch" }> {
  return {
    kind: "DepositBatch",
    user,
    amount: BNB,
    lpBnb: (3n * BNB) / 10n,
    lpTokenValueBnb: (3n * BNB) / 10n,
    builderBnb: BNB / 10n,
    vaultBnb: BNB / 10n,
    directReferrer,
    directBnb: directReferrer ? BNB / 10n : 0n,
    nodePayouts: [],
  };
}

function serviceWith(
  chain: ChainClient,
  journal: ExecutionJournal,
  state = new ProtocolState("root"),
  beforeCommandSubmit?: (id: string, command: OperatorCommand) => Promise<void>,
): OperatorService {
  return new OperatorService(
    new Engine(defaultProtocolConfig()),
    state,
    journal,
    { containsEvent: () => false, insertEvent: () => undefined },
    chain,
    undefined,
    beforeCommandSubmit,
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

  it("stops immediately when the submission lease is lost without failing untouched commands", async () => {
    const journal = new ExecutionJournal();
    const ids = journal.planBatch("static:0xuser:slot", [
      { kind: "PayRewardTokenByBnbValue", to: "alice", amount: 1n },
      { kind: "PayRewardTokenByBnbValue", to: "bob", amount: 2n },
    ]);
    const submitted: string[] = [];
    let leaseChecks = 0;
    const service = serviceWith(
      {
        async submit(command) {
          submitted.push(command.kind === "PayRewardTokenByBnbValue" ? command.to : command.kind);
          return TX_HASH;
        },
      },
      journal,
      new ProtocolState("root"),
      async () => {
        leaseChecks += 1;
        if (leaseChecks === 2) throw new Error("submission lease lost");
      },
    );

    await expect(service.submitPending()).rejects.toThrow("submission lease lost");
    expect(submitted).toEqual(["alice"]);
    expect(journal.records.get(ids[0])!.status.state).toBe("Confirmed");
    expect(journal.records.get(ids[1])!.status.state).toBe("Pending");
    expect(journal.records.get(ids[1])!.attempts).toBe(0);
  });

  it("skips a stale pending snapshot entry that another runner already confirmed", async () => {
    const journal = new ExecutionJournal();
    const ids = journal.planBatch("static:0xuser:slot", [
      { kind: "PayRewardTokenByBnbValue", to: "alice", amount: 1n },
      { kind: "PayRewardTokenByBnbValue", to: "bob", amount: 2n },
    ]);
    const submitted: string[] = [];
    let leaseChecks = 0;
    const service = serviceWith(
      {
        async submit(command) {
          submitted.push(command.kind === "PayRewardTokenByBnbValue" ? command.to : command.kind);
          return TX_HASH;
        },
      },
      journal,
      new ProtocolState("root"),
      async () => {
        leaseChecks += 1;
        if (leaseChecks === 2) journal.markConfirmed(ids[1], TX_HASH);
      },
    );

    await expect(service.submitPending()).resolves.toEqual([TX_HASH]);
    expect(submitted).toEqual(["alice"]);
    expect(journal.records.get(ids[1])!.status).toEqual({ state: "Confirmed", txHash: TX_HASH });
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

  it("submits rapid deposits in chain order, not tx hash order", () => {
    const state = new ProtocolState("root");
    const journal = new ExecutionJournal();
    const service = serviceWith({ async submit() { return TX_HASH; } }, journal, state);
    const highTx = `0x${"f".repeat(64)}`;
    const lowTx = `0x${"0".repeat(64)}`;

    service.processEvent({ blockNumber: 1n, blockHash: "0x1", txHash: highTx, logIndex: 0, event: { kind: "RefBound", id: `${highTx}:0`, user: "alice", referrer: "root" } });
    service.processEvent({ blockNumber: 1n, blockHash: "0x1", txHash: highTx, logIndex: 1, event: { kind: "Deposit", id: `${highTx}:1`, user: "alice", amount: BNB } });
    service.processEvent({ blockNumber: 1n, blockHash: "0x1", txHash: lowTx, logIndex: 2, event: { kind: "RefBound", id: `${lowTx}:2`, user: "bob", referrer: "alice" } });
    service.processEvent({ blockNumber: 1n, blockHash: "0x1", txHash: lowTx, logIndex: 3, event: { kind: "Deposit", id: `${lowTx}:3`, user: "bob", amount: BNB } });

    const pendingUsers = journal.pendingCommands().map(([, command]) => command.kind === "DepositBatch" ? command.user : command.kind);
    expect(pendingUsers).toEqual(["alice", "bob"]);
  });

  it("rebuilds planning state by chain order when pending deposit ids sort differently", () => {
    const state = new ProtocolState("root");
    const setupEngine = new Engine(defaultProtocolConfig());
    setupEngine.bind(state, "alice", "root");
    setupEngine.bind(state, "bob", "alice");
    const journal = new ExecutionJournal();
    const firstId = journal.planBatch(`deposit:0x${"f".repeat(64)}:0`, [depositCommand("alice", "root")], {
      blockNumber: 1n,
      logIndex: 1,
    })[0];
    const secondId = journal.planBatch(`deposit:0x${"0".repeat(64)}:0`, [depositCommand("bob", "alice")], {
      blockNumber: 1n,
      logIndex: 2,
    })[0];
    expect(firstId > secondId).toBe(true);

    const service = serviceWith({ async submit() { return TX_HASH; } }, journal, state);
    const planningState = (service as unknown as { planningState: ProtocolState }).planningState;
    expect(planningState.user("alice")!.principalBnb).toBe(BNB);
    expect(planningState.user("alice")!.dynamicPaidBnb).toBe(BNB / 10n);
  });
});

describe("service: tax sweep throttling", () => {
  it("accumulates tax events and flushes one aggregate sweep per slot", () => {
    const state = new ProtocolState("root");
    const journal = new ExecutionJournal();
    const service = serviceWith({ async submit() { return TX_HASH; } }, journal, state);

    service.processEvent({
      blockNumber: 1n,
      blockHash: "0x1",
      txHash: "0x1",
      logIndex: 0,
      event: { kind: "TaxCollected", id: "0x1:0", from: "pair", to: "buyer-a", amount: 3n * BNB, side: "Buy" },
    });
    service.processEvent({
      blockNumber: 1n,
      blockHash: "0x1",
      txHash: "0x2",
      logIndex: 1,
      event: { kind: "TaxCollected", id: "0x2:1", from: "pair", to: "buyer-b", amount: 6n * BNB, side: "Buy" },
    });

    expect(journal.pendingCommands()).toHaveLength(0);
    expect(state.pendingTaxSweep.taxTokenAmount).toBe(9n * BNB);
    expect(state.pendingTaxSweep.builderTokenAmount).toBe(3n * BNB);

    const command = service.tickTaxSweep("2026-06-10T14:20Z");
    expect(command).toMatchObject({
      kind: "SweepTaxToBnb",
      taxTokenAmount: 9n * BNB,
      builderTokenAmount: 3n * BNB,
      burnTokenAmount: 0n,
      ownerBnbBpsOfSold: 0,
      vaultBnbBpsOfSold: 10_000,
    });
    expect(state.pendingTaxSweep.taxTokenAmount).toBe(0n);
    expect(journal.pendingCommands()).toHaveLength(1);
    expect(journal.pendingCommands()[0][0]).toBe("tax:2026-06-10T14:20Z:0:sweep-tax-to-bnb");
  });

  it("keeps same-slot overflow pending for the next tax slot", () => {
    const state = new ProtocolState("root");
    const journal = new ExecutionJournal();
    const service = serviceWith({ async submit() { return TX_HASH; } }, journal, state);

    service.processEvent({ blockNumber: 1n, blockHash: "0x1", txHash: "0x1", logIndex: 0, event: { kind: "TaxCollected", id: "0x1:0", from: "pair", to: "buyer-a", amount: 3n * BNB, side: "Buy" } });
    expect(service.tickTaxSweep("2026-06-10T14:20Z")).not.toBe(null);
    service.processEvent({ blockNumber: 1n, blockHash: "0x1", txHash: "0x2", logIndex: 1, event: { kind: "TaxCollected", id: "0x2:1", from: "pair", to: "buyer-b", amount: 6n * BNB, side: "Buy" } });

    expect(service.tickTaxSweep("2026-06-10T14:20Z")).toBe(null);
    expect(state.pendingTaxSweep.taxTokenAmount).toBe(6n * BNB);
    const next = service.tickTaxSweep("2026-06-10T14:21Z");
    expect(next).toMatchObject({ kind: "SweepTaxToBnb", taxTokenAmount: 6n * BNB, builderTokenAmount: 2n * BNB });
  });

  it("keeps dust tax pending until it reaches the sweep threshold", () => {
    const state = new ProtocolState("root");
    const journal = new ExecutionJournal();
    const service = serviceWith({ async submit() { return TX_HASH; } }, journal, state);

    service.processEvent({ blockNumber: 1n, blockHash: "0x1", txHash: "0x1", logIndex: 0, event: { kind: "TaxCollected", id: "0x1:0", from: "pair", to: "buyer-a", amount: 3n, side: "Buy" } });

    expect(service.tickTaxSweep("2026-06-10T14:20Z")).toBe(null);
    expect(journal.pendingCommands()).toHaveLength(0);
    expect(state.pendingTaxSweep.taxTokenAmount).toBe(3n);
  });
});

describe("service: settlement derived counters", () => {
  it("rebuilds invested-direct counts before team reward settlement", () => {
    const state = new ProtocolState("root");
    const setupEngine = new Engine(defaultProtocolConfig());
    setupEngine.bind(state, "alice", "root");
    setupEngine.deposit(state, "alice", BNB);
    setupEngine.bind(state, "bob", "alice");
    setupEngine.deposit(state, "bob", BNB);
    state.ensureUserMut("alice").investedDirectCount = 0;

    const journal = new ExecutionJournal();
    const service = serviceWith({ async submit() { return TX_HASH; } }, journal, state);
    service.tickSettlements("period-1");

    expect(state.user("alice")!.investedDirectCount).toBe(1);
    const aliceRewards = journal.pendingCommands()
      .map(([, command]) => command)
      .filter((command) => command.kind === "PayRewardTokenByBnbValue" && command.to === "alice");
    expect(aliceRewards.some((command) => command.kind === "PayRewardTokenByBnbValue" && command.amount === BNB / 5000n)).toBe(true);
  });
});
