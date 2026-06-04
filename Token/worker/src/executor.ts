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
  }
}

/** executor.rs:89 */
export function commandsForDeposit(a: DepositAllocation): OperatorCommand[] {
  const commands: OperatorCommand[] = [
    { kind: "AddLiquidity", bnbAmount: a.lpBnb, tokenValueBnb: a.lpTokenValueBnb },
    { kind: "BuilderBuy", bnbAmount: a.builderBnb },
    { kind: "CreditVault", amount: a.vaultBnb },
  ];
  for (const payout of a.nodePayouts) {
    commands.push({ kind: "TransferBnb", to: payout.to, amount: payout.amount, reason: payout.reason });
  }
  if (a.directReferrer != null && a.directBnb !== 0n) {
    commands.push({ kind: "TransferBnb", to: a.directReferrer, amount: a.directBnb, reason: "direct-referral" });
  }
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
