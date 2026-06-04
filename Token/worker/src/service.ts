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
import type { ProtocolState } from "./state";

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
}

export class OperatorService {
  constructor(
    public engine: Engine,
    public state: ProtocolState,
    public journal: ExecutionJournal,
    public database: ServiceDatabase,
    public chain: ChainClient,
  ) {}

  /** service.rs:62 */
  processEvent(indexed: IndexedEvent): EventOutcome {
    const eventId = indexed.event.id;
    if (this.database.containsEvent(eventId) || this.state.processedEvents.has(eventId)) {
      return { kind: "Duplicate" };
    }

    let plannedCommands = 0;
    const event = indexed.event;
    switch (event.kind) {
      case "RefBound": {
        // Tolerate self-referral RefBound(x,x): just register the user.
        if (event.user === event.referrer) {
          if (!this.state.isBound(event.user)) this.state.ensureUserMut(event.user);
        } else {
          this.engine.bind(this.state, event.user, event.referrer);
        }
        break;
      }
      case "Deposit": {
        const allocation = this.engine.deposit(this.state, event.user, event.amount);
        const commands = commandsForDeposit(allocation);
        plannedCommands = commands.length;
        this.journal.planBatch(`deposit:${eventId}`, commands);
        break;
      }
      case "TaxCollected": {
        const command = this.planTaxSweep(event.amount, event.side);
        if (command) {
          this.journal.planBatch(`tax:${eventId}`, [command]);
          plannedCommands = 1;
        }
        break;
      }
    }

    this.state.processedEvents.add(eventId);
    this.database.insertEvent(indexed);
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

  /** service.rs:220 — drain pending; on error stop. Returns tx hashes. */
  async submitPending(): Promise<string[]> {
    const txHashes: string[] = [];
    for (const [id, command] of this.journal.pendingCommands()) {
      try {
        const txHash = await this.chain.submit(command);
        this.journal.markSubmitted(id, txHash);
        this.journal.markConfirmed(id);
        txHashes.push(txHash);
      } catch (e) {
        this.journal.markFailed(id, String((e as Error).message ?? e));
        throw e;
      }
    }
    return txHashes;
  }

  /** service.rs:226 */
  private planTaxSweep(taxTokenAmount: bigint, side: TaxSide): OperatorCommand | null {
    if (taxTokenAmount === 0n) return null;
    const split = taxSplitFromEngine(this.engine, side);
    if (split.taxBps === 0) return null;

    const grossBnbValue = grossBnbValueFromTaxTokens(
      taxTokenAmount,
      split.taxBps,
      this.state.pair.tokenReserve,
      this.state.pair.bnbReserve,
    );
    this.engine.applyTradeTax(this.state, side, grossBnbValue);

    const builderTokenAmount = prorateTaxTokens(taxTokenAmount, split.builderBps, split.taxBps);
    const burnTokenAmount = prorateTaxTokens(taxTokenAmount, split.burnBps, split.taxBps);
    const sellTokenAmount = taxTokenAmount - builderTokenAmount - burnTokenAmount;
    this.state.balances.builderTokenAmount += builderTokenAmount;
    this.state.balances.burnedTokens += burnTokenAmount;

    if (burnTokenAmount === 0n && sellTokenAmount === 0n) return null;

    const ownerBnbBpsOfSold = splitBpsOfSold(split.ownerBps, split.sellBps);
    const vaultBnbBpsOfSold =
      split.vaultBps === 0 ? 0 : Math.max(0, Number(BPS_DENOMINATOR) - ownerBnbBpsOfSold);

    return {
      kind: "SweepTaxToBnb",
      taxTokenAmount,
      builderTokenAmount,
      burnTokenAmount,
      ownerBnbBpsOfSold,
      vaultBnbBpsOfSold,
    };
  }
}

export class ServiceError extends Error {}
export { EngineError };

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

function splitBpsOfSold(partBps: number, sellBps: number): number {
  if (partBps === 0 || sellBps === 0) return 0;
  return Math.floor((partBps * Number(BPS_DENOMINATOR)) / sellBps);
}
