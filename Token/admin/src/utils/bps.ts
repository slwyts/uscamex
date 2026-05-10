// Basis-points <-> percent helpers (1% = 100 bps).
export function bpsToPercentText(bps: number | bigint): string {
  const value = typeof bps === "bigint" ? bps : BigInt(bps);
  const whole = value / 100n;
  const frac = (value % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function percentTextToBps(text: string): number {
  const value = text.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(value)) {
    throw new Error("百分比格式错误（最多两位小数）");
  }
  const [whole, fraction = ""] = value.split(".");
  const bps = BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2));
  if (bps > 1_000_000n) throw new Error("百分比数值过大");
  return Number(bps);
}
