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

  /** engine.rs:130 */
  deposit(state: ProtocolState, user: Address, amount: bigint): DepositAllocation {
    if (amount < this.config.minDeposit || amount > this.config.maxDeposit) {
      throw new EngineError("DepositOutOfRange");
    }
    if (!state.isBound(user)) throw new EngineError("UserNotBound");
    this.validateDistribution();

    const lpTotal = bps(amount, this.config.lpBuildBps);
    const lpBnb = lpTotal / 2n;
    const lpTokenValueBnb = lpTotal - lpBnb;
    const nodePayouts = this.distributeNodes(state, bps(amount, this.config.nodeBps));
    const nodeBnb = nodePayouts.reduce((acc, p) => acc + p.amount, 0n);
    const builderBnb = bps(amount, this.config.builderBuyBps);
    const vaultBase = bps(amount, this.config.vaultBps);
    const directPool = bps(amount, this.config.directPoolBps);
    const directReferrer = state.user(user)?.referrer ?? null;

    let configuredDirectBnb = 0n;
    if (directReferrer != null && directReferrer !== user) {
      configuredDirectBnb = bps(amount, this.config.directRewardBps);
    }
    let directBnb = configuredDirectBnb;
    const lpRedeems: LpRedeem[] = [];
    if (directReferrer != null) {
      const account = state.user(directReferrer);
      if (account && account.exited && !account.active) {
        directBnb = 0n;
      } else if (account && account.active && account.principalBnb > 0n) {
        const room = this.remainingExitRoom(state, directReferrer) ?? 0n;
        directBnb = directBnb < room ? directBnb : room;
      }
    }
    const directRemainder = satSub(directPool, directBnb);

    state.pair.bnbReserve = state.pair.bnbReserve + lpBnb + lpTokenValueBnb + builderBnb;
    state.balances.builderTokenValueBnb += builderBnb;
    state.balances.vaultBnb += vaultBase + directRemainder;

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
    state.balances.totalActiveLpPrincipalBnb += lpBnb;

    if (directReferrer != null && directBnb !== 0n) {
      mapAdd(state.balances.directPaidBnb, directReferrer, directBnb);
      const ref = state.user(directReferrer);
      if (ref && ref.active && ref.principalBnb > 0n) {
        state.ensureUserMut(directReferrer).dynamicPaidBnb += directBnb;
        const redeem = this.exitIfCapReached(state, directReferrer);
        if (redeem) lpRedeems.push(redeem);
      }
    }

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
    const room0 = this.remainingExitRoom(state, user) ?? 0n;
    const staticBnb = periodStaticBnb < room0 ? periodStaticBnb : room0;
    const ancestors = this.ancestors(state, user, 10);
    const teamRewards: RewardPayout[] = [];
    const lpRedeems: LpRedeem[] = [];

    state.ensureUserMut(user).staticPaidBnb += staticBnb;
    ancestors.forEach((ancestor, index) => {
      const generation = index + 1;
      const rewardRate = this.config.teamRewardBps[index];
      const a = state.user(ancestor);
      const eligible =
        !!a && a.active && a.principalBnb > 0n && a.directCount >= generation;
      if (!eligible) return;

      const room = this.remainingExitRoom(state, ancestor) ?? 0n;
      const amountRaw = bps(staticBnb, rewardRate);
      const amount = amountRaw < room ? amountRaw : room;
      if (amount === 0n) {
        if (room === 0n) {
          const redeem = this.exitIfCapReached(state, ancestor);
          if (redeem) lpRedeems.push(redeem);
        }
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

  /** engine.rs:589 */
  private remainingExitRoom(state: ProtocolState, user: string): bigint | null {
    const account = state.user(user);
    if (!account) return null;
    if (!account.active || account.principalBnb === 0n) return 0n;
    const exitTarget = (account.principalBnb * BigInt(this.config.exitMultipleBps)) / BPS_DENOMINATOR;
    const totalPaid = account.staticPaidBnb + account.dynamicPaidBnb;
    return satSub(exitTarget, totalPaid);
  }
}
