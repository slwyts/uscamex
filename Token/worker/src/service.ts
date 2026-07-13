/**
 * Operator service layer. Port of Token/offchain/src/service.rs.
 * Combines engine accounting, journaling, persistence hooks, and command submission.
 * Designed to run inside the OperatorDO (which owns state + journal + D1 mirror).
 */
import { BPS_DENOMINATOR } from "./config";
import { Engine, EngineError, type TaxSide } from "./engine";
import {
  commandsForDeposit,
  commandsForSettlement,
  type OperatorCommand,
} from "./executor";
import type { IndexedEvent } from "./indexer";
import { ExecutionJournal } from "./journal";
import { deserializeState, newPendingTaxSweep, rebuildInvestedDirectCounts, serializeState, type PendingTaxSweep, type ProtocolState } from "./state";

const MIN_TAX_SWEEP_SELL_TOKENS = 10n ** 18n;

export type EventOutcome =
  | { kind: "Applied"; plannedCommands: number }
  | { kind: "Duplicate" };

/** Database mirror hooks the DO implements (D1-backed). */
export interface ServiceDatabase {
  containsEvent(eventId: string): boolean;
  insertEvent(event: IndexedEvent): void;
}

/** Chain client interface (BscTransactionClient or a test recorder). */
export interface ChainClient {
  submit(command: OperatorCommand): Promise<string>;
  afterConfirmed?(id: string, command: OperatorCommand, txHash: string): Promise<void>;
  findConfirmedCommand?(id: string, command: OperatorCommand): Promise<string | null>;
}

export type BeforeCommandSubmit = (id: string, command: OperatorCommand) => Promise<void>;

export class OperatorService {
  private planningState: ProtocolState;

  constructor(
    public engine: Engine,
    public state: ProtocolState,
    public journal: ExecutionJournal,
    public eventCache: ServiceDatabase,
    public chain: ChainClient,
    private onPersist?: () => Promise<void>,
    private beforeCommandSubmit?: BeforeCommandSubmit,
  ) {
    this.planningState = buildPlanningState(engine, state, journal);
  }

  /** service.rs:62 */
  processEvent(indexed: IndexedEvent): EventOutcome {
    const eventId = indexed.event.id;
    if (this.eventCache.containsEvent(eventId) || this.state.processedEvents.has(eventId)) {
      return { kind: "Duplicate" };
    }

    let plannedCommands = 0;
    const event = indexed.event;
    switch (event.kind) {
      case "RefBound": {
        // Trust the chain: the contract already validated the bind before emitting.
        // Adopt it unconditionally, materializing the upline if event ordering put
        // the downline first. Never reject or throw on a RefBound.
        this.engine.adoptChainBind(this.state, event.user, event.referrer);
        this.engine.adoptChainBind(this.planningState, event.user, event.referrer);
        break;
      }
      case "Deposit": {
        const allocation = this.engine.computeDeposit(this.planningState, event.user, event.amount);
        const commands = commandsForDeposit(allocation);
        plannedCommands = commands.length;
        this.journal.planBatch(`deposit:${eventId}`, commands, {
          blockNumber: indexed.blockNumber,
          logIndex: indexed.logIndex,
        });
        this.engine.applyDeposit(this.planningState, allocation);
        break;
      }
      case "TaxCollected": {
        this.recordTaxForSweep(this.state, event.amount, event.side);
        if (this.planningState !== this.state) this.recordTaxForSweep(this.planningState, event.amount, event.side);
        break;
      }
    }

    this.state.processedEvents.add(eventId);
    this.eventCache.insertEvent(indexed);
    return { kind: "Applied", plannedCommands };
  }

  /** service.rs:119 */
  settleOnce(user: string, periodKey: string): OperatorCommand[] | null {
    const settlement = this.engine.settleStaticPeriodOnce(this.state, user, periodKey);
    if (!settlement) return null;
    const commands = commandsForSettlement(settlement);
    this.journal.planBatch(`static:${user}:${periodKey}`, commands);
    return commands;
  }

  /** service.rs:143 — uplines settled before downlines. */
  tickSettlements(periodKey: string): number {
    rebuildInvestedDirectCounts(this.state);
    const activeUsers = [...this.state.users.entries()]
      .filter(([, a]) => a.active && a.principalBnb > 0n)
      .map(([address]) => address);
    activeUsers.sort((l, r) => {
      const dl = referralDepth(this.state, l);
      const dr = referralDepth(this.state, r);
      if (dl !== dr) return dl - dr;
      return l < r ? -1 : l > r ? 1 : 0;
    });
    let settled = 0;
    for (const user of activeUsers) {
      try {
        if (this.settleOnce(user, periodKey)) settled += 1;
      } catch {
        // skip individual failures (matches Rust Err(_) => {})
      }
    }
    return settled;
  }

  /** service.rs:171 */
  tickDeflation(day: bigint, slotKey: string): bigint | null {
    const amount = this.engine.applyDeflation(this.state, day);
    if (amount === 0n) return null;
    this.journal.planBatch(`deflation:${slotKey}`, [
      { kind: "PullPairTokens", bps: this.engine.config.deflationHourlyBps },
    ]);
    return amount;
  }

  /** service.rs:197 */
  tickBuyback(slotKey: string): bigint | null {
    const vaultBefore = this.state.balances.vaultBnb;
    const burned = this.engine.buybackTick(this.state);
    if (burned === 0n) return null;
    const spent = vaultBefore - this.state.balances.vaultBnb;
    this.journal.planBatch(`buyback:${slotKey}`, [{ kind: "Buyback", bnbAmount: spent }]);
    return burned;
  }

  /** Plan at most one aggregate tax sweep for this slot. TaxCollected events only accumulate. */
  tickTaxSweep(slotKey: string): OperatorCommand | null {
    const batchKey = `tax:${slotKey}`;
    if (this.journal.records.has(`${batchKey}:0:sweep-tax-to-bnb`)) return null;

    if (pendingTaxIsEmpty(this.state.pendingTaxSweep)) return null;
    if (pendingTaxHasNoOnchainAction(this.state.pendingTaxSweep)) {
      this.state.pendingTaxSweep = newPendingTaxSweep();
      this.planningState.pendingTaxSweep = newPendingTaxSweep();
      return null;
    }

    const command = commandForPendingTaxSweep(this.state.pendingTaxSweep);
    if (!command) return null;

    this.journal.planBatch(batchKey, [command]);
    this.state.pendingTaxSweep = newPendingTaxSweep();
    this.planningState.pendingTaxSweep = newPendingTaxSweep();
    return command;
  }

  /** service.rs:220 — drain pending; on error stop. Returns tx hashes. */
  async submitPending(): Promise<string[]> {
    const txHashes: string[] = [];
    this.journal.retryFailed();
    for (const [id, command] of this.journal.pendingCommands()) {
      // The pending list is a snapshot. A long settlement drain can outlive a
      // submission lease, so validate/renew that lease before every command.
      // Keep this outside the command try/catch: losing the lease must stop the
      // old runner without marking an untouched command as Failed.
      await this.beforeCommandSubmit?.(id, command);

      // Another request in the same isolate may have confirmed an item from the
      // snapshot while this runner was awaiting storage/RPC. Never resubmit a
      // record whose live journal status is no longer Pending.
      if (this.journal.records.get(id)?.status.state !== "Pending") continue;

      try {
        // Idempotency guard: before (re)submitting, check whether this exact command
        // already landed on-chain (e.g. a prior attempt that we lost the receipt for).
        // This is only done for the pending set, NOT a full-journal sweep every tick,
        // so a backlog can never explode RPC usage and time out the DO.
        const existingTxHash = await this.chain.findConfirmedCommand?.(id, command);
        if (existingTxHash) {
          await this.chain.afterConfirmed?.(id, command, existingTxHash);
          this.journal.markConfirmed(id, existingTxHash);
          await this.onPersist?.();
          txHashes.push(existingTxHash);
          continue;
        }
        const txHash = await this.chain.submit(command);
        this.journal.markSubmitted(id, txHash);
        await this.chain.afterConfirmed?.(id, command, txHash);
        this.journal.markConfirmed(id);
        await this.onPersist?.();
        txHashes.push(txHash);
      } catch (e) {
        const err = String((e as Error).message ?? e);
        console.error(`submitPending: ${id} failed: ${err}`);
        if (this.journal.canRetry(id, err)) {
          this.journal.markFailed(id, err);
          this.journal.resetToPending(id);
        } else {
          this.journal.markFailed(id, err);
        }
      }
    }
    return txHashes;
  }

  /** service.rs:226 */
  private recordTaxForSweep(state: ProtocolState, taxTokenAmount: bigint, side: TaxSide): void {
    if (taxTokenAmount === 0n) return;
    const split = taxSplitFromEngine(this.engine, side);
    if (split.taxBps === 0) return;

    const grossBnbValue = grossBnbValueFromTaxTokens(
      taxTokenAmount,
      split.taxBps,
      state.pair.tokenReserve,
      state.pair.bnbReserve,
    );
    this.engine.applyTradeTax(state, side, grossBnbValue);

    const builderTokenAmount = prorateTaxTokens(taxTokenAmount, split.builderBps, split.taxBps);
    const burnTokenAmount = prorateTaxTokens(taxTokenAmount, split.burnBps, split.taxBps);
    const sellTokenAmount = taxTokenAmount - builderTokenAmount - burnTokenAmount;
    state.balances.builderTokenAmount += builderTokenAmount;
    state.balances.burnedTokens += burnTokenAmount;
    state.pendingTaxSweep.taxTokenAmount += taxTokenAmount;
    state.pendingTaxSweep.builderTokenAmount += builderTokenAmount;
    state.pendingTaxSweep.burnTokenAmount += burnTokenAmount;
    const ownerSellTokenAmount = prorateTaxTokens(taxTokenAmount, split.ownerBps, split.taxBps);
    state.pendingTaxSweep.ownerSellTokenAmount += ownerSellTokenAmount;
    state.pendingTaxSweep.vaultSellTokenAmount += sellTokenAmount - ownerSellTokenAmount;
  }
}

export class ServiceError extends Error {}
export { EngineError };

export function depositAllocationFromCommand(command: Extract<OperatorCommand, { kind: "DepositBatch" }>) {
  const nodePayouts = command.nodePayouts.map((p) => ({ to: p.to, amount: p.amount, reason: "node" }));
  return {
    user: command.user,
    amount: command.amount,
    lpBnb: command.lpBnb,
    lpTokenValueBnb: command.lpTokenValueBnb,
    nodePayouts,
    nodeBnb: nodePayouts.reduce((sum, p) => sum + p.amount, 0n),
    builderBnb: command.builderBnb,
    vaultBnb: command.vaultBnb,
    directBnb: command.directBnb,
    directReferrer: command.directReferrer,
    lpRedeems: [],
  };
}

function buildPlanningState(engine: Engine, state: ProtocolState, journal: ExecutionJournal): ProtocolState {
  const planning = deserializeState(serializeState(state));
  const records = journal.recordsInExecutionOrder();
  for (const record of records) {
    if (record.status.state === "Confirmed") continue;
    if (record.command.kind !== "DepositBatch") continue;
    if (planning.appliedDepositBatches.has(record.id)) continue;
    engine.applyDeposit(planning, depositAllocationFromCommand(record.command));
    planning.appliedDepositBatches.add(record.id);
  }
  return planning;
}

function referralDepth(state: ProtocolState, user: string): number {
  let depth = 0;
  let cursor = user;
  while (depth < 1024) {
    const next = state.user(cursor)?.referrer ?? null;
    if (next == null || next === cursor || next === "") break;
    depth += 1;
    cursor = next;
  }
  return depth;
}

interface TaxSplit {
  taxBps: number;
  builderBps: number;
  ownerBps: number;
  vaultBps: number;
  burnBps: number;
  sellBps: number;
}

function makeTaxSplit(taxBps: number, builderBps: number, ownerBps: number, vaultBps: number): TaxSplit {
  const distributed = builderBps + ownerBps + vaultBps;
  const burnBps = Math.max(0, taxBps - distributed);
  const sellBps = ownerBps + vaultBps;
  return { taxBps, builderBps, ownerBps, vaultBps, burnBps, sellBps };
}

function taxSplitFromEngine(engine: Engine, side: TaxSide): TaxSplit {
  const c = engine.config;
  return side === "Buy"
    ? makeTaxSplit(c.buyTaxBps, c.buyTaxBuilderBps, 0, c.buyTaxVaultBps)
    : makeTaxSplit(c.sellTaxBps, c.sellTaxBuilderBps, c.sellTaxOwnerBps, c.sellTaxVaultBps);
}

function grossBnbValueFromTaxTokens(
  taxTokenAmount: bigint,
  taxBps: number,
  tokenReserve: bigint,
  bnbReserve: bigint,
): bigint {
  if (taxBps === 0 || tokenReserve === 0n || bnbReserve === 0n) return 0n;
  return (taxTokenAmount * BPS_DENOMINATOR * bnbReserve) / BigInt(taxBps) / tokenReserve;
}

function prorateTaxTokens(taxTokenAmount: bigint, partBps: number, taxBps: number): bigint {
  if (partBps === 0 || taxBps === 0) return 0n;
  return (taxTokenAmount * BigInt(partBps)) / BigInt(taxBps);
}

function commandForPendingTaxSweep(pending: PendingTaxSweep): Extract<OperatorCommand, { kind: "SweepTaxToBnb" }> | null {
  const sellTokenAmount = pending.taxTokenAmount - pending.builderTokenAmount - pending.burnTokenAmount;
  if (sellTokenAmount < 0n) throw new ServiceError("pending tax sweep over-allocated");
  if (pending.burnTokenAmount === 0n && sellTokenAmount < MIN_TAX_SWEEP_SELL_TOKENS) return null;

  const ownerBnbBpsOfSoldRaw = sellTokenAmount === 0n
    ? 0
    : Number((pending.ownerSellTokenAmount * BPS_DENOMINATOR) / sellTokenAmount);
  const ownerBnbBpsOfSold = Math.min(Number(BPS_DENOMINATOR), Math.max(0, ownerBnbBpsOfSoldRaw));
  return {
    kind: "SweepTaxToBnb",
    taxTokenAmount: pending.taxTokenAmount,
    builderTokenAmount: pending.builderTokenAmount,
    burnTokenAmount: pending.burnTokenAmount,
    ownerBnbBpsOfSold,
    vaultBnbBpsOfSold: sellTokenAmount === 0n ? 0 : Math.max(0, Number(BPS_DENOMINATOR) - ownerBnbBpsOfSold),
  };
}

function pendingTaxIsEmpty(pending: PendingTaxSweep): boolean {
  return pending.taxTokenAmount === 0n;
}

function pendingTaxHasNoOnchainAction(pending: PendingTaxSweep): boolean {
  const sellTokenAmount = pending.taxTokenAmount - pending.builderTokenAmount - pending.burnTokenAmount;
  return pending.taxTokenAmount !== 0n && pending.burnTokenAmount === 0n && sellTokenAmount === 0n;
}
