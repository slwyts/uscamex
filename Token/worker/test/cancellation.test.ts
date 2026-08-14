import { describe, expect, it } from "vitest";
import {
  applyPendingRewardCancellation,
  buildPendingRewardCancellationPlan,
} from "../src/cancellation";
import { defaultProtocolConfig } from "../src/config";
import { ExecutionJournal } from "../src/journal";
import { ProtocolState } from "../src/state";

const USER = `0x${"1".repeat(40)}`;
const UPLINE = `0x${"2".repeat(40)}`;
const TX = `0x${"a".repeat(64)}`;

function confirmedDeposit(journal: ExecutionJournal, amount: bigint, lpBnb: bigint, lpToken: bigint): void {
  const [id] = journal.planBatch(`deposit:${TX}:0`, [{
    kind: "DepositBatch",
    user: USER,
    amount,
    lpBnb,
    lpTokenValueBnb: lpBnb,
    builderBnb: 0n,
    vaultBnb: 0n,
    directReferrer: null,
    directBnb: 0n,
    nodePayouts: [],
  }], { blockNumber: 1n, logIndex: 0 });
  journal.markSubmitted(id, TX);
  journal.markConfirmed(id);
  const account = lpToken;
  expect(account).toBeGreaterThan(0n);
}

describe("pending reward cancellation", () => {
  it("cancels only pending static rewards and rolls back their accounting", () => {
    const state = new ProtocolState(USER);
    state.ensureUserMut(USER).staticPaidBnb = 100n;
    state.ensureUserMut(UPLINE).dynamicPaidBnb = 20n;
    const journal = new ExecutionJournal();
    const ids = journal.planBatch(`static:${USER}:2026-08-15T00:00+08/4`, [
      { kind: "PayRewardTokenByBnbValue", to: USER, amount: 100n },
      { kind: "PayRewardTokenByBnbValue", to: UPLINE, amount: 20n },
    ]);
    journal.planBatch("tax:2026-08-15T00:01Z", [{
      kind: "SweepTaxToBnb",
      taxTokenAmount: 10n,
      builderTokenAmount: 0n,
      burnTokenAmount: 0n,
      ownerBnbBpsOfSold: 0,
      vaultBnbBpsOfSold: 10_000,
    }]);

    const plan = buildPendingRewardCancellationPlan(state, journal, defaultProtocolConfig());
    expect(plan.rewardRecordIds).toEqual(ids);
    expect(plan.remainingPendingByKind).toEqual({ SweepTaxToBnb: 1 });
    expect(plan.blockers).toEqual([]);

    applyPendingRewardCancellation(state, journal, defaultProtocolConfig(), plan, "snapshot");
    expect(state.user(USER)?.staticPaidBnb).toBe(0n);
    expect(state.user(UPLINE)?.dynamicPaidBnb).toBe(0n);
    expect(ids.map((id) => journal.records.get(id)?.status.state)).toEqual(["Cancelled", "Cancelled"]);
    expect(journal.pendingCommands().map(([, command]) => command.kind)).toEqual(["SweepTaxToBnb"]);
  });

  it("reopens an unredeemed position when cancelled rewards put it below the cap", () => {
    const config = { ...defaultProtocolConfig(), exitMultipleBps: 10_000 };
    const state = new ProtocolState(USER);
    const account = state.ensureUserMut(USER);
    account.principalBnb = 1_000n;
    account.staticPaidBnb = 1_000n;
    account.active = false;
    account.exited = true;
    const journal = new ExecutionJournal();
    confirmedDeposit(journal, 1_000n, 300n, 777n);
    const ids = journal.planBatch(`static:${USER}:2026-08-15T00:00+08/4`, [
      { kind: "PayRewardTokenByBnbValue", to: USER, amount: 1_000n },
      { kind: "RedeemUserLp", user: USER, lpTokenAmount: 777n },
    ]);

    const plan = buildPendingRewardCancellationPlan(state, journal, config);
    expect(plan.blockers).toEqual([]);
    const result = applyPendingRewardCancellation(state, journal, config, plan, "snapshot");

    expect(result).toEqual({ reopenedUsers: 1, replacementRedeems: 0 });
    expect(state.user(USER)).toMatchObject({
      active: true,
      exited: false,
      staticPaidBnb: 0n,
      lpBnbPrincipal: 300n,
      lpTokenPrincipal: 777n,
    });
    expect(state.balances.totalActiveLpPrincipalBnb).toBe(300n);
    expect(ids.map((id) => journal.records.get(id)?.status.state)).toEqual(["Cancelled", "Cancelled"]);
  });

  it("keeps a valid cap exit by replacing a redeem whose old prerequisites were cancelled", () => {
    const config = { ...defaultProtocolConfig(), exitMultipleBps: 10_000 };
    const state = new ProtocolState(USER);
    const account = state.ensureUserMut(USER);
    account.principalBnb = 1_000n;
    account.staticPaidBnb = 2_000n;
    account.active = false;
    account.exited = true;
    const journal = new ExecutionJournal();
    confirmedDeposit(journal, 1_000n, 300n, 777n);
    const ids = journal.planBatch(`static:${USER}:2026-08-15T00:00+08/4`, [
      { kind: "PayRewardTokenByBnbValue", to: USER, amount: 1_000n },
      { kind: "RedeemUserLp", user: USER, lpTokenAmount: 777n },
    ]);

    const plan = buildPendingRewardCancellationPlan(state, journal, config);
    const result = applyPendingRewardCancellation(state, journal, config, plan, "snapshot");

    expect(result).toEqual({ reopenedUsers: 0, replacementRedeems: 1 });
    expect(journal.records.get(ids[1])?.status.state).toBe("Cancelled");
    expect(journal.pendingCommands().some(([id]) => id.startsWith(`exit-reconcile:${USER}:snapshot`))).toBe(true);
  });
});
