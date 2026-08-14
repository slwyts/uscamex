import type { ProtocolConfig } from "./config";
import type { OperatorCommand } from "./executor";
import { ExecutionJournal, type CommandRecord } from "./journal";
import type { ProtocolState } from "./state";

interface BalanceRollback {
  staticBnb: bigint;
  dynamicBnb: bigint;
}

interface PendingRedeem {
  record: CommandRecord;
  command: Extract<OperatorCommand, { kind: "RedeemUserLp" }>;
}

export interface PendingRewardCancellationPlan {
  rewardRecordIds: string[];
  dependentRedeemRecordIds: string[];
  settlementBatches: string[];
  settlementSlots: string[];
  affectedUsers: string[];
  rewardBnb: bigint;
  staticRollbackBnb: bigint;
  dynamicRollbackBnb: bigint;
  remainingPendingByKind: Record<string, number>;
  blockers: string[];
  warnings: string[];
  rollbacks: Map<string, BalanceRollback>;
  dependentRedeems: PendingRedeem[];
}

/** Build a deterministic, read-only cancellation plan from the current DO snapshot. */
export function buildPendingRewardCancellationPlan(
  state: ProtocolState,
  journal: ExecutionJournal,
  config: ProtocolConfig,
): PendingRewardCancellationPlan {
  const rewardRecords: CommandRecord[] = [];
  const rollbacks = new Map<string, BalanceRollback>();
  const batches = new Set<string>();
  const slots = new Set<string>();
  const blockers: string[] = [];
  const warnings: string[] = [];
  const remainingPendingByKind: Record<string, number> = {};
  let rewardBnb = 0n;
  let staticRollbackBnb = 0n;
  let dynamicRollbackBnb = 0n;

  for (const record of journal.recordsInExecutionOrder()) {
    if (record.status.state !== "Pending") continue;
    if (record.command.kind !== "PayRewardTokenByBnbValue") {
      remainingPendingByKind[record.command.kind] =
        (remainingPendingByKind[record.command.kind] ?? 0) + 1;
      continue;
    }

    const parsed = parseStaticRewardId(record.id);
    if (!parsed) {
      blockers.push(`pending reward has unsupported id: ${record.id}`);
      continue;
    }
    const recipient = record.command.to.toLowerCase();
    const account = state.user(recipient);
    if (!account) {
      blockers.push(`pending reward recipient is missing: ${record.id}`);
      continue;
    }
    if (parsed.index === 0 && recipient !== parsed.user) {
      blockers.push(`static reward recipient mismatch: ${record.id}`);
      continue;
    }

    rewardRecords.push(record);
    batches.add(parsed.batchKey);
    slots.add(parsed.slot);
    rewardBnb += record.command.amount;
    const rollback = rollbacks.get(recipient) ?? { staticBnb: 0n, dynamicBnb: 0n };
    if (parsed.index === 0) {
      rollback.staticBnb += record.command.amount;
      staticRollbackBnb += record.command.amount;
    } else {
      rollback.dynamicBnb += record.command.amount;
      dynamicRollbackBnb += record.command.amount;
    }
    rollbacks.set(recipient, rollback);
  }

  for (const [address, rollback] of rollbacks) {
    const account = state.user(address)!;
    if (account.staticPaidBnb < rollback.staticBnb) {
      blockers.push(`static rollback exceeds balance for ${address}`);
    }
    if (account.dynamicPaidBnb < rollback.dynamicBnb) {
      blockers.push(`dynamic rollback exceeds balance for ${address}`);
    }
  }

  const dependentRedeems: PendingRedeem[] = [];
  const redeemsByUser = new Map<string, PendingRedeem[]>();
  for (const record of journal.recordsInExecutionOrder()) {
    if (record.status.state !== "Pending" || record.command.kind !== "RedeemUserLp") continue;
    const batchKey = batchKeyFromRecordId(record.id);
    if (!batchKey || !batches.has(batchKey)) continue;
    const redeem = { record, command: record.command };
    dependentRedeems.push(redeem);
    const user = record.command.user.toLowerCase();
    const entries = redeemsByUser.get(user) ?? [];
    entries.push(redeem);
    redeemsByUser.set(user, entries);
  }

  for (const [user, redeems] of redeemsByUser) {
    if (redeems.length > 1) blockers.push(`multiple pending LP redemptions for ${user}`);
  }

  for (const [address, rollback] of rollbacks) {
    const account = state.user(address)!;
    const afterPaid =
      account.staticPaidBnb - rollback.staticBnb +
      account.dynamicPaidBnb - rollback.dynamicBnb;
    const exitTarget =
      (account.principalBnb * BigInt(config.exitMultipleBps)) / 10_000n;
    if (!account.active && account.exited && afterPaid < exitTarget) {
      const redeems = redeemsByUser.get(address) ?? [];
      if (redeems.length === 0) {
        warnings.push(`confirmed or missing LP redemption prevents reopening ${address}`);
        continue;
      }
      const redeem = redeems[0];
      const lpBnb = currentPositionLpBnb(journal, address, account.principalBnb);
      if (lpBnb == null) blockers.push(`cannot reconstruct LP BNB principal for ${address}`);
      if (redeem.command.lpTokenAmount === 0n) blockers.push(`invalid zero LP redemption for ${address}`);
    }
  }

  return {
    rewardRecordIds: rewardRecords.map((record) => record.id),
    dependentRedeemRecordIds: dependentRedeems.map(({ record }) => record.id),
    settlementBatches: [...batches].sort(),
    settlementSlots: [...slots].sort(),
    affectedUsers: [...rollbacks.keys()].sort(),
    rewardBnb,
    staticRollbackBnb,
    dynamicRollbackBnb,
    remainingPendingByKind,
    blockers,
    warnings,
    rollbacks,
    dependentRedeems,
  };
}

export function cancellationSnapshotMaterial(plan: PendingRewardCancellationPlan): string {
  return JSON.stringify({
    rewards: plan.rewardRecordIds,
    redeems: plan.dependentRedeemRecordIds,
    rewardBnb: plan.rewardBnb.toString(),
    staticRollbackBnb: plan.staticRollbackBnb.toString(),
    dynamicRollbackBnb: plan.dynamicRollbackBnb.toString(),
    blockers: plan.blockers,
  });
}

/** Apply a previously revalidated plan. The caller persists state + journal atomically. */
export function applyPendingRewardCancellation(
  state: ProtocolState,
  journal: ExecutionJournal,
  config: ProtocolConfig,
  plan: PendingRewardCancellationPlan,
  snapshot: string,
): { reopenedUsers: number; replacementRedeems: number } {
  if (plan.blockers.length !== 0) throw new Error(`cancellation blocked: ${plan.blockers.join("; ")}`);

  for (const id of plan.rewardRecordIds) {
    if (!journal.cancelPending(id, `cancelled pending reward snapshot ${snapshot}`)) {
      throw new Error(`pending reward changed before cancellation: ${id}`);
    }
  }

  for (const [address, rollback] of plan.rollbacks) {
    const account = state.user(address);
    if (!account) throw new Error(`reward recipient disappeared: ${address}`);
    account.staticPaidBnb -= rollback.staticBnb;
    account.dynamicPaidBnb -= rollback.dynamicBnb;
  }

  let reopenedUsers = 0;
  let replacementRedeems = 0;
  const replacementUsers = new Set<string>();
  for (const { record, command } of plan.dependentRedeems) {
    if (!journal.cancelPending(record.id, `cancelled with pending rewards snapshot ${snapshot}`)) {
      throw new Error(`dependent LP redemption changed before cancellation: ${record.id}`);
    }
    const user = command.user.toLowerCase();
    const account = state.user(user);
    if (!account) throw new Error(`LP redemption user disappeared: ${user}`);
    const paid = account.staticPaidBnb + account.dynamicPaidBnb;
    const exitTarget = (account.principalBnb * BigInt(config.exitMultipleBps)) / 10_000n;
    if (paid < exitTarget) {
      const lpBnb = currentPositionLpBnb(journal, user, account.principalBnb);
      if (lpBnb == null) throw new Error(`cannot reconstruct LP BNB principal for ${user}`);
      account.active = true;
      account.exited = false;
      account.lpBnbPrincipal = lpBnb;
      account.lpTokenPrincipal = command.lpTokenAmount;
      state.balances.totalActiveLpPrincipalBnb += lpBnb;
      reopenedUsers += 1;
      continue;
    }

    if (!replacementUsers.has(user)) {
      journal.planBatch(`exit-reconcile:${user}:${snapshot}`, [command]);
      replacementUsers.add(user);
      replacementRedeems += 1;
    }
  }

  return { reopenedUsers, replacementRedeems };
}

function parseStaticRewardId(
  id: string,
): { user: string; slot: string; index: number; batchKey: string } | null {
  const match = /^static:(0x[0-9a-fA-F]{40}):(.+):(\d+):pay-reward-token$/.exec(id);
  if (!match) return null;
  const index = Number(match[3]);
  if (!Number.isSafeInteger(index)) return null;
  const user = match[1].toLowerCase();
  return { user, slot: match[2], index, batchKey: `static:${user}:${match[2]}` };
}

function batchKeyFromRecordId(id: string): string | null {
  const match = /^(.*):\d+:[^:]+$/.exec(id);
  return match?.[1] ?? null;
}

function currentPositionLpBnb(
  journal: ExecutionJournal,
  user: string,
  principalBnb: bigint,
): bigint | null {
  let deposited = 0n;
  let lpBnb = 0n;
  const records = journal.recordsInExecutionOrder().slice().reverse();
  for (const record of records) {
    if (record.status.state !== "Confirmed" || record.command.kind !== "DepositBatch") continue;
    if (record.command.user.toLowerCase() !== user) continue;
    deposited += record.command.amount;
    lpBnb += record.command.lpBnb;
    if (deposited === principalBnb) return lpBnb;
    if (deposited > principalBnb) return null;
  }
  return null;
}
