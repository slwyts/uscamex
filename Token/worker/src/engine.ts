/**
 * Deterministic protocol accounting. High-fidelity port of Token/offchain/src/engine.rs.
 * Pure logic over ProtocolState. All wei math is bigint. Rust's u128 saturating_sub
 * (clamp at 0) is reproduced via satSub() since bigint can go negative.
 */
import { bps, BPS_DENOMINATOR, type ProtocolConfig } from "./config";
import type { Address, ProtocolState } from "./state";

function satSub(a: bigint, b: bigint): bigint {
  const r = a - b;
  return r < 0n ? 0n : r;
}

function mapAdd(map: Map<string, bigint>, key: string, delta: bigint): void {
  map.set(key, (map.get(key) ?? 0n) + delta);
}

/** Pure: compute per-node payout shares without touching any state. */
function computeNodePayouts(nodes: { address: string; weight: number }[], amount: bigint): BnbPayout[] {
  const totalWeight = nodes.reduce((sum, n) => sum + n.weight, 0);
  if (amount === 0n || totalWeight === 0) return [];
  const payouts: BnbPayout[] = [];
  for (const node of nodes) {
    const share = (amount * BigInt(node.weight)) / BigInt(totalWeight);
    if (share !== 0n) payouts.push({ to: node.address, amount: share, reason: "node" });
  }
  return payouts;
}

export type EngineErrorKind =
  | "SelfReferral"
  | "ReferrerNotBound"
  | "UserNotBound"
  | "DepositOutOfRange"
  | "InactivePosition"
  | "InvalidConfig";

export class EngineError extends Error {
  constructor(public kind: EngineErrorKind) {
    super(kind);
  }
}

export interface BnbPayout {
  to: Address;
  amount: bigint;
  reason: string;
}

export interface LpRedeem {
  user: Address;
  lpTokenAmount: bigint;
}

export interface DepositAllocation {
  user: Address;
  amount: bigint;
  lpBnb: bigint;
  lpTokenValueBnb: bigint;
  nodePayouts: BnbPayout[];
  nodeBnb: bigint;
  builderBnb: bigint;
  vaultBnb: bigint;
  directBnb: bigint;
  directReferrer: Address | null;
  lpRedeems: LpRedeem[];
}

export interface RewardPayout {
  user: Address;
  amount: bigint;
  generation: number;
}

export type TaxSide = "Buy" | "Sell";

export interface StaticSettlement {
  user: Address;
  staticBnb: bigint;
  teamRewards: RewardPayout[];
  exited: boolean;
  exitRefundBnb: bigint | null;
  lpRedeemBnbShare: bigint | null;
  totalActiveLpPrincipalBnb: bigint;
  lpRedeems: LpRedeem[];
}

export interface TaxAllocation {
  side: TaxSide;
  grossBnbValue: bigint;
  totalTaxBnb: bigint;
  builderTokenValueBnb: bigint;
  vaultBnb: bigint;
  ownerBnb: bigint;
  burnedTokenValueBnb: bigint;
}

export class Engine {
  constructor(public config: ProtocolConfig) {}

  /** engine.rs:108 */
  bind(state: ProtocolState, user: Address, referrer: Address): boolean {
    if (user === referrer) throw new EngineError("SelfReferral");
    if (state.isBound(user)) return false;
    if (!state.isBound(referrer)) throw new EngineError("ReferrerNotBound");
    state.ensureUserMut(user).referrer = referrer;
    state.ensureUserMut(referrer).directCount += 1;
    return true;
  }

  /**
   * Adopt an on-chain RefBound unconditionally. The contract's `_bind` already
   * enforces the no-broken-chain rule before emitting RefBound, so the worker
   * must trust the chain and never reject a bind because of local event ordering
   * (e.g. a downline RefBound processed before its upline's in the same batch).
   * Missing upline records are materialized so the relationship is never dropped.
   */
  adoptChainBind(state: ProtocolState, user: Address, referrer: Address): boolean {
    if (user === referrer) {
      // root / self-bind: just make sure the account exists.
      state.ensureUserMut(user);
      return false;
    }
    if (state.user(user)?.referrer != null) return false;
    state.ensureUserMut(referrer);
    state.ensureUserMut(user).referrer = referrer;
    state.ensureUserMut(referrer).directCount += 1;
    return true;
  }

  /** engine.rs:130 */
  deposit(state: ProtocolState, user: Address, amount: bigint): DepositAllocation {
    const allocation = this.computeDeposit(state, user, amount);
    this.applyDeposit(state, allocation);
    return allocation;
  }

  /**
   * Pure computation of a deposit's allocation. Does NOT modify state —
   * state is only committed in {@link applyDeposit} after the on-chain
   * DepositBatch has been confirmed. This makes high-volume concurrent
   * deposits safe: a failed batch leaves no phantom ledger entries.
   */
  computeDeposit(state: ProtocolState, user: Address, amount: bigint): DepositAllocation {
    if (amount < this.config.minDeposit || amount > this.config.maxDeposit) {
      throw new EngineError("DepositOutOfRange");
    }
    if (!state.isBound(user)) throw new EngineError("UserNotBound");
    this.validateDistribution();

    const lpTotal = bps(amount, this.config.lpBuildBps);
    const lpBnb = lpTotal / 2n;
    const lpTokenValueBnb = lpTotal - lpBnb;
    const nodePayouts = computeNodePayouts(state.nodes, bps(amount, this.config.nodeBps));
    const nodeBnb = nodePayouts.reduce((acc, p) => acc + p.amount, 0n);
    const builderBnb = bps(amount, this.config.builderBuyBps);
    const vaultBase = bps(amount, this.config.vaultBps);
    const directPool = bps(amount, this.config.directPoolBps);
    const directReferrer = state.user(user)?.referrer ?? null;

    const directBnb = directReferrer != null && directReferrer !== user
      ? bps(amount, this.config.directRewardBps)
      : 0n;
    const lpRedeems: LpRedeem[] = [];
    if (directBnb !== 0n && directReferrer != null) {
      const account = state.user(directReferrer);
      if (account && account.active && account.principalBnb > 0n) {
        const willExit = this.willExitAfter(state, directReferrer, directBnb);
        if (willExit) lpRedeems.push(willExit);
      }
    }
    const directRemainder = satSub(directPool, directBnb);

    return {
      user,
      amount,
      lpBnb,
      lpTokenValueBnb,
      nodePayouts,
      nodeBnb,
      builderBnb,
      vaultBnb: vaultBase + directRemainder,
      directBnb,
      directReferrer,
      lpRedeems,
    };
  }

  /**
   * Commit all state changes for a deposit whose on-chain batch is confirmed.
   * Must be called with the exact {@link DepositAllocation} returned by
   * {@link computeDeposit} on the same state snapshot.
   */
  applyDeposit(state: ProtocolState, allocation: DepositAllocation): void {
    const { user, amount, lpBnb, lpTokenValueBnb, builderBnb, vaultBnb, directBnb, directReferrer, lpRedeems, nodePayouts } = allocation;

    state.pair.bnbReserve = state.pair.bnbReserve + lpBnb + lpTokenValueBnb + builderBnb;
    state.balances.builderTokenValueBnb += builderBnb;
    state.balances.vaultBnb += vaultBnb;

    const account = state.ensureUserMut(user);
    if (account.exited && !account.active) {
      account.positionId += 1n;
      account.principalBnb = 0n;
      account.staticPaidBnb = 0n;
      account.dynamicPaidBnb = 0n;
      account.lpBnbPrincipal = 0n;
      account.lpTokenPrincipal = 0n;
    }
    account.principalBnb += amount;
    account.lpBnbPrincipal += lpBnb;
    account.active = true;
    account.exited = false;
    if (!account.hasInvested) {
      account.hasInvested = true;
      if (directReferrer != null && directReferrer !== user) {
        state.ensureUserMut(directReferrer).investedDirectCount += 1;
      }
    }
    state.balances.totalActiveLpPrincipalBnb += lpBnb;

    for (const p of nodePayouts) {
      mapAdd(state.balances.nodePaidBnb, p.to, p.amount);
    }
    const nodeAllocation = bps(amount, this.config.nodeBps);
    const nodeDust = satSub(nodeAllocation, allocation.nodeBnb);
    state.balances.ownerBnb += nodeDust;

    if (directReferrer != null && directBnb !== 0n) {
      mapAdd(state.balances.directPaidBnb, directReferrer, directBnb);
      const ref = state.user(directReferrer);
      if (ref && ref.active && ref.principalBnb > 0n) {
        state.ensureUserMut(directReferrer).dynamicPaidBnb += directBnb;
        this.exitIfCapReached(state, directReferrer);
      }
    }

    for (const redeem of lpRedeems) {
      this.exitIfCapReached(state, redeem.user);
    }
  }

  /**
   * Check whether adding `delta` to `user`'s dynamicPaidBnb would push them past
   * the exit cap, and if so return the LP redeem info WITHOUT modifying state.
   * Used by {@link computeDeposit} to pre-calculate lpRedeems.
   */
  private willExitAfter(state: ProtocolState, user: string, delta: bigint): LpRedeem | null {
    const account = state.user(user);
    if (!account) return null;
    if (!account.active || account.principalBnb === 0n) return null;
    const exitTarget = (account.principalBnb * BigInt(this.config.exitMultipleBps)) / BPS_DENOMINATOR;
    const projectedTotal = account.staticPaidBnb + account.dynamicPaidBnb + delta;
    if (projectedTotal < exitTarget) return null;
    const lpTokenAmount = account.lpTokenPrincipal;
    if (lpTokenAmount === 0n) return null;
    return { user, lpTokenAmount };
  }

  /** engine.rs:242 — keyed idempotency. */
  settleStaticPeriodOnce(
    state: ProtocolState,
    user: Address,
    periodKey: string,
  ): StaticSettlement | null {
    const id = `static:${user}:${periodKey}`;
    if (state.processedSettlements.has(id)) return null;
    const settlement = this.settleStaticPeriod(state, user);
    state.processedSettlements.add(id);
    return settlement;
  }

  /** engine.rs:259 */
  settleStaticPeriod(state: ProtocolState, user: Address): StaticSettlement {
    const account = state.user(user);
    if (!account) throw new EngineError("UserNotBound");
    if (!account.active || account.principalBnb === 0n) throw new EngineError("InactivePosition");
    if (this.config.settlementPeriodsPerDay === 0) throw new EngineError("InvalidConfig");

    const periodStaticBnb =
      bps(account.principalBnb, this.config.dailyStaticBps) /
      BigInt(this.config.settlementPeriodsPerDay);
    const staticBnb = periodStaticBnb;
    const ancestors = this.ancestors(state, user, 10);
    const teamRewards: RewardPayout[] = [];
    const lpRedeems: LpRedeem[] = [];

    state.ensureUserMut(user).staticPaidBnb += staticBnb;
    ancestors.forEach((ancestor, index) => {
      const generation = index + 1;
      const rewardRate = this.config.teamRewardBps[index];
      const a = state.user(ancestor);
      const eligible =
        !!a && a.active && a.principalBnb > 0n && a.investedDirectCount >= generation;
      if (!eligible) return;

      const amountRaw = bps(staticBnb, rewardRate);
      const amount = amountRaw;
      if (amount === 0n) {
        return;
      }
      state.ensureUserMut(ancestor).dynamicPaidBnb += amount;
      teamRewards.push({ user: ancestor, amount, generation });
      const redeem = this.exitIfCapReached(state, ancestor);
      if (redeem) lpRedeems.push(redeem);
    });

    const userRedeem = this.exitIfCapReached(state, user);
    let exitRefundBnb: bigint | null = null;
    const acctNow = state.user(user);
    const exited = !!acctNow && !acctNow.active && acctNow.exited;
    if (userRedeem) {
      exitRefundBnb = state.user(user)?.principalBnb ?? null;
      lpRedeems.push(userRedeem);
    } else if (exited) {
      exitRefundBnb = state.user(user)?.principalBnb ?? null;
    }

    return {
      user,
      staticBnb,
      teamRewards,
      exited,
      exitRefundBnb,
      lpRedeemBnbShare: null,
      totalActiveLpPrincipalBnb: state.balances.totalActiveLpPrincipalBnb,
      lpRedeems,
    };
  }

  /** engine.rs:350 — voluntary exit. Returns [principal, lpShare]. */
  withdrawLp(state: ProtocolState, user: Address): [bigint, bigint] {
    const account = state.ensureUserMut(user);
    if (!account.active || account.principalBnb === 0n) throw new EngineError("InactivePosition");
    account.active = false;
    account.exited = true;
    const principal = account.principalBnb;
    const lpShare = account.lpBnbPrincipal;
    account.lpBnbPrincipal = 0n;
    account.lpTokenPrincipal = 0n;
    state.balances.totalActiveLpPrincipalBnb = satSub(
      state.balances.totalActiveLpPrincipalBnb,
      lpShare,
    );
    return [principal, lpShare];
  }

  /** engine.rs:372 */
  applyDeflation(state: ProtocolState, day: bigint): bigint {
    if (day !== state.currentDay) {
      state.currentDay = day;
      state.deflationUsedBps = 0;
    }
    if (!this.config.deflationEnabled) return 0n;
    const remaining = Math.max(0, this.config.deflationDailyCapBps - state.deflationUsedBps);
    const bpsToUse = Math.min(remaining, this.config.deflationHourlyBps);
    if (bpsToUse === 0) return 0n;
    const amount = bps(state.pair.tokenReserve, bpsToUse);
    state.pair.tokenReserve = satSub(state.pair.tokenReserve, amount);
    state.balances.builderTokenAmount += amount;
    state.deflationUsedBps += bpsToUse;
    return amount;
  }

  /** engine.rs:396 */
  buybackTick(state: ProtocolState): bigint {
    if (
      !this.config.buybackEnabled ||
      state.balances.vaultBnb === 0n ||
      state.pair.bnbReserve === 0n ||
      state.pair.tokenReserve === 0n
    ) {
      return 0n;
    }
    const spend =
      state.balances.vaultBnb < this.config.buybackPerMinute
        ? state.balances.vaultBnb
        : this.config.buybackPerMinute;
    let tokens = (spend * state.pair.tokenReserve) / state.pair.bnbReserve;
    if (tokens > state.pair.tokenReserve) tokens = state.pair.tokenReserve;
    state.balances.vaultBnb -= spend;
    state.pair.bnbReserve += spend;
    state.pair.tokenReserve = satSub(state.pair.tokenReserve, tokens);
    state.balances.burnedTokens += tokens;
    return tokens;
  }

  /** engine.rs:417 */
  applyTradeTax(state: ProtocolState, side: TaxSide, grossBnbValue: bigint): TaxAllocation {
    let allocation: TaxAllocation;
    if (side === "Buy") {
      const totalTaxBnb = bps(grossBnbValue, this.config.buyTaxBps);
      const builderTokenValueBnb = bps(grossBnbValue, this.config.buyTaxBuilderBps);
      const vaultBnb = bps(grossBnbValue, this.config.buyTaxVaultBps);
      const burnedTokenValueBnb = satSub(totalTaxBnb, builderTokenValueBnb + vaultBnb);
      allocation = {
        side,
        grossBnbValue,
        totalTaxBnb,
        builderTokenValueBnb,
        vaultBnb,
        ownerBnb: 0n,
        burnedTokenValueBnb,
      };
    } else {
      const totalTaxBnb = bps(grossBnbValue, this.config.sellTaxBps);
      const builderTokenValueBnb = bps(grossBnbValue, this.config.sellTaxBuilderBps);
      const ownerBnb = bps(grossBnbValue, this.config.sellTaxOwnerBps);
      const vaultBnb = bps(grossBnbValue, this.config.sellTaxVaultBps);
      const burnedTokenValueBnb = satSub(
        totalTaxBnb,
        builderTokenValueBnb + ownerBnb + vaultBnb,
      );
      allocation = {
        side,
        grossBnbValue,
        totalTaxBnb,
        builderTokenValueBnb,
        vaultBnb,
        ownerBnb,
        burnedTokenValueBnb,
      };
    }

    if (
      allocation.totalTaxBnb !==
      allocation.builderTokenValueBnb +
        allocation.vaultBnb +
        allocation.ownerBnb +
        allocation.burnedTokenValueBnb
    ) {
      throw new EngineError("InvalidConfig");
    }
    state.balances.builderTokenValueBnb += allocation.builderTokenValueBnb;
    state.balances.vaultBnb += allocation.vaultBnb;
    state.balances.ownerBnb += allocation.ownerBnb;
    state.balances.taxBurnedTokenValueBnb += allocation.burnedTokenValueBnb;
    return allocation;
  }

  // ---- internals ----

  /** engine.rs:487 */
  private distributeNodes(state: ProtocolState, amount: bigint): BnbPayout[] {
    const totalWeight = state.nodes.reduce((acc, n) => acc + n.weight, 0);
    if (amount === 0n || totalWeight === 0) {
      state.balances.ownerBnb += amount;
      return [];
    }
    let paid = 0n;
    const payouts: BnbPayout[] = [];
    for (const node of state.nodes) {
      const share = (amount * BigInt(node.weight)) / BigInt(totalWeight);
      paid += share;
      mapAdd(state.balances.nodePaidBnb, node.address, share);
      if (share !== 0n) {
        payouts.push({ to: node.address, amount: share, reason: "node" });
      }
    }
    const dust = satSub(amount, paid);
    state.balances.ownerBnb += dust;
    return payouts;
  }

  /** engine.rs:520 */
  private validateDistribution(): void {
    const totalBps =
      this.config.lpBuildBps +
      this.config.nodeBps +
      this.config.builderBuyBps +
      this.config.vaultBps +
      this.config.directPoolBps;
    if (totalBps > Number(BPS_DENOMINATOR) || this.config.directRewardBps > this.config.directPoolBps) {
      throw new EngineError("InvalidConfig");
    }
  }

  /** engine.rs:534 */
  private ancestors(state: ProtocolState, user: string, depth: number): Address[] {
    const result: Address[] = [];
    let cursor = user;
    while (result.length < depth) {
      const next = state.user(cursor)?.referrer ?? null;
      if (next == null) break;
      if (next === cursor || next === "") break;
      result.push(next);
      cursor = next;
    }
    return result;
  }

  /** engine.rs:553 */
  private exitIfCapReached(state: ProtocolState, user: string): LpRedeem | null {
    const account = state.user(user);
    if (!account) return null;
    if (!account.active || account.principalBnb === 0n) return null;
    const exitTarget = (account.principalBnb * BigInt(this.config.exitMultipleBps)) / BPS_DENOMINATOR;
    const totalPaid = account.staticPaidBnb + account.dynamicPaidBnb;
    if (totalPaid < exitTarget) return null;

    const lpTokenAmount = account.lpTokenPrincipal;
    if (lpTokenAmount === 0n) return null;

    const acct = state.ensureUserMut(user);
    acct.active = false;
    acct.exited = true;
    const lpBnbShare = acct.lpBnbPrincipal;
    acct.lpBnbPrincipal = 0n;
    acct.lpTokenPrincipal = 0n;
    state.balances.totalActiveLpPrincipalBnb = satSub(
      state.balances.totalActiveLpPrincipalBnb,
      lpBnbShare,
    );
    return { user, lpTokenAmount };
  }

}
