/**
 * Protocol configuration + money helpers.
 * Port of Token/offchain/src/config.rs. All wei amounts are bigint.
 */

export const BNB = 10n ** 18n;
export const BPS_DENOMINATOR = 10_000n;

export interface ProtocolConfig {
  minDeposit: bigint;
  maxDeposit: bigint;

  lpBuildBps: number;
  nodeBps: number;
  builderBuyBps: number;
  vaultBps: number;
  directPoolBps: number;
  directRewardBps: number;

  dailyStaticBps: number;
  settlementPeriodsPerDay: number; // u8
  exitMultipleBps: number; // u32

  teamRewardBps: number[]; // length 10

  deflationEnabled: boolean;
  deflationHourlyBps: number;
  deflationDailyCapBps: number;

  buybackEnabled: boolean;
  buybackPerMinute: bigint;

  buyTaxBps: number;
  buyTaxBuilderBps: number;
  buyTaxVaultBps: number;

  sellTaxBps: number;
  sellTaxBuilderBps: number;
  sellTaxOwnerBps: number;
  sellTaxVaultBps: number;

  bindCost: bigint; // referral binding cost in project tokens (wei)
}

export function defaultProtocolConfig(): ProtocolConfig {
  return {
    minDeposit: BNB / 10n,
    maxDeposit: 5n * BNB,
    lpBuildBps: 6000,
    nodeBps: 1000,
    builderBuyBps: 1000,
    vaultBps: 1000,
    directPoolBps: 1000,
    directRewardBps: 1000,
    dailyStaticBps: 80,
    settlementPeriodsPerDay: 4,
    exitMultipleBps: 30000,
    teamRewardBps: [1000, 900, 800, 700, 600, 500, 500, 500, 500, 500],
    deflationEnabled: true,
    deflationHourlyBps: 10,
    deflationDailyCapBps: 200,
    buybackEnabled: true,
    buybackPerMinute: BNB / 10n,
    buyTaxBps: 300,
    buyTaxBuilderBps: 100,
    buyTaxVaultBps: 200,
    sellTaxBps: 1000,
    sellTaxBuilderBps: 300,
    sellTaxOwnerBps: 300,
    sellTaxVaultBps: 400,
    bindCost: 11n * BNB,
  };
}

export class ConfigError extends Error {}

/** Mirrors config.rs validate(). */
export function validateConfig(c: ProtocolConfig): void {
  if (c.minDeposit > c.maxDeposit) throw new ConfigError("min_deposit > max_deposit");
  if (c.lpBuildBps + c.nodeBps + c.builderBuyBps + c.vaultBps + c.directPoolBps > 10_000) {
    throw new ConfigError("deposit allocation bps exceed 10000");
  }
  if (c.directRewardBps > c.directPoolBps) {
    throw new ConfigError("direct_reward_bps > direct_pool_bps");
  }
  if (c.settlementPeriodsPerDay === 0) throw new ConfigError("settlement_periods_per_day must be > 0");
  if (c.exitMultipleBps === 0) throw new ConfigError("exit_multiple_bps must be > 0");
  if (c.deflationHourlyBps > c.deflationDailyCapBps || c.deflationDailyCapBps > 10_000) {
    throw new ConfigError("invalid deflation bps");
  }
  if (c.teamRewardBps.length !== 10) throw new ConfigError("team_reward_bps must have 10 entries");
  for (const r of c.teamRewardBps) {
    if (r > 10_000) throw new ConfigError("team_reward bps exceeds 10000");
  }
  if (c.buyTaxBps > 2500) throw new ConfigError("buy_tax_bps > 2500");
  if (c.sellTaxBps > 2500) throw new ConfigError("sell_tax_bps > 2500");
  if (c.buyTaxBuilderBps + c.buyTaxVaultBps > c.buyTaxBps) {
    throw new ConfigError("buy tax sub-splits exceed buy_tax_bps");
  }
  if (c.sellTaxBuilderBps + c.sellTaxOwnerBps + c.sellTaxVaultBps > c.sellTaxBps) {
    throw new ConfigError("sell tax sub-splits exceed sell_tax_bps");
  }
}

/** amount * rate / 10000 (config.rs bps()). */
export function bps(amount: bigint, rate: number): bigint {
  return (amount * BigInt(rate)) / BPS_DENOMINATOR;
}

/** Decimal BNB string -> wei. <=18 fraction digits. */
export function parseBnbAmount(input: string): bigint {
  const [whole, frac = ""] = input.trim().split(".");
  if (frac.length > 18) throw new ConfigError("too many fractional digits");
  const padded = (frac + "0".repeat(18)).slice(0, 18);
  return BigInt(whole || "0") * BNB + BigInt(padded || "0");
}

/** wei -> decimal BNB string (trims trailing zeros). */
export function formatBnbAmount(wei: bigint): string {
  const whole = wei / BNB;
  const frac = (wei % BNB).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
