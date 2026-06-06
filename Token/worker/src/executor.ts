/**
 * OperatorCommand definitions + command builders. Port of Token/offchain/src/executor.rs.
 */
import type { DepositAllocation, RewardPayout, StaticSettlement } from "./engine";

export type OperatorCommand =
  | { kind: "AddLiquidity"; bnbAmount: bigint; tokenValueBnb: bigint }
  | { kind: "TransferBnb"; to: string; amount: bigint; reason: string }
  | { kind: "BuilderBuy"; bnbAmount: bigint }
  | { kind: "CreditVault"; amount: bigint }
  | { kind: "PullPairTokens"; bps: number }
  | { kind: "Buyback"; bnbAmount: bigint }
  | { kind: "PayRewardTokenByBnbValue"; to: string; amount: bigint }
  | { kind: "BurnTokenByBnbValue"; amount: bigint; reason: string }
  | { kind: "ExitPosition"; user: string; refundBnb: bigint }
  | { kind: "RedeemUserLp"; user: string; lpBnbShare: bigint; totalActivePrincipal: bigint }
  | {
      kind: "DepositBatch";
      user: string;
      lpBnb: bigint;
      lpTokenValueBnb: bigint;
      builderBnb: bigint;
      vaultBnb: bigint;
      directReferrer: string | null;
      directBnb: bigint;
      nodePayouts: { to: string; amount: bigint }[];
    }
  | {
      kind: "SweepTaxToBnb";
      taxTokenAmount: bigint;
      builderTokenAmount: bigint;
      burnTokenAmount: bigint;
      ownerBnbBpsOfSold: number;
      vaultBnbBpsOfSold: number;
    };

/** executor.rs:72 — journal kind. TransferBnb/BurnToken use their `reason`. */
export function commandKind(c: OperatorCommand): string {
  switch (c.kind) {
    case "AddLiquidity":
      return "add-liquidity";
    case "TransferBnb":
      return c.reason;
    case "BuilderBuy":
      return "builder-buy";
    case "CreditVault":
      return "credit-vault";
    case "PullPairTokens":
      return "pull-pair-tokens";
    case "Buyback":
      return "buyback";
    case "PayRewardTokenByBnbValue":
      return "pay-reward-token";
    case "BurnTokenByBnbValue":
      return c.reason;
    case "ExitPosition":
      return "exit-position";
    case "RedeemUserLp":
      return "redeem-user-lp";
    case "SweepTaxToBnb":
      return "sweep-tax-to-bnb";
    case "DepositBatch":
      return "deposit-batch";
  }
}

/** executor.rs:89 */
export function commandsForDeposit(a: DepositAllocation): OperatorCommand[] {
  // The full deposit distribution (LP build + builder buy + vault credit + node
  // payouts + direct referral) is executed as ONE typed on-chain depositBatch.
  // All-or-nothing: a partial failure reverts the whole tx, so native assets are
  // never half-spent and retries stay idempotent.
  const commands: OperatorCommand[] = [
    {
      kind: "DepositBatch",
      user: a.user,
      lpBnb: a.lpBnb,
      lpTokenValueBnb: a.lpTokenValueBnb,
      builderBnb: a.builderBnb,
      vaultBnb: a.vaultBnb,
      directReferrer: a.directReferrer != null && a.directBnb !== 0n ? a.directReferrer : null,
      directBnb: a.directReferrer != null && a.directBnb !== 0n ? a.directBnb : 0n,
      nodePayouts: a.nodePayouts.map((p) => ({ to: p.to, amount: p.amount })),
    },
  ];
  // LP redemptions triggered by this deposit (referrer cap exits) stay as separate
  // commands: they are independent of the deposit's BNB allocation and operate on
  // existing LP custody, so they don't need to be inside the deposit batch.
  for (const redeem of a.lpRedeems) {
    commands.push({
      kind: "RedeemUserLp",
      user: redeem.user,
      lpBnbShare: redeem.lpBnbShare,
      totalActivePrincipal: redeem.totalActivePrincipal,
    });
  }
  return commands;
}

/** executor.rs:131 */
export function commandsForSettlement(s: StaticSettlement): OperatorCommand[] {
  const commands: OperatorCommand[] = [];
  if (s.staticBnb !== 0n) {
    commands.push({ kind: "PayRewardTokenByBnbValue", to: s.user, amount: s.staticBnb });
  }
  for (const reward of s.teamRewards) commands.push(commandForTeamReward(reward));
  for (const redeem of s.lpRedeems) {
    commands.push({
      kind: "RedeemUserLp",
      user: redeem.user,
      lpBnbShare: redeem.lpBnbShare,
      totalActivePrincipal: redeem.totalActivePrincipal,
    });
  }
  return commands;
}

function commandForTeamReward(reward: RewardPayout): OperatorCommand {
  return { kind: "PayRewardTokenByBnbValue", to: reward.user, amount: reward.amount };
}
