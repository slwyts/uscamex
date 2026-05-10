// Lightweight wei <-> bnb decimal helpers using BigInt.
const TEN_18 = 10n ** 18n;

export function parseBnb(value: string | number): bigint {
  const text = String(value).trim();
  if (text === "" || text === "-") return 0n;
  const negative = text.startsWith("-");
  const body = negative ? text.slice(1) : text;
  const [whole, fraction = ""] = body.split(".");
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction)) {
    throw new Error("BNB 金额格式错误");
  }
  if (fraction.length > 18) throw new Error("BNB 小数最多 18 位");
  const padded = (fraction + "0".repeat(18)).slice(0, 18);
  const wei = BigInt(whole) * TEN_18 + BigInt(padded);
  return negative ? -wei : wei;
}

export function formatBnb(wei: bigint | string | number, maxDecimals = 6): string {
  const value = typeof wei === "bigint" ? wei : BigInt(wei || 0);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / TEN_18;
  const frac = (abs % TEN_18).toString().padStart(18, "0");
  const trimmed = frac.replace(/0+$/, "").slice(0, maxDecimals);
  const head = whole.toString();
  return `${negative ? "-" : ""}${trimmed ? `${head}.${trimmed}` : head}`;
}

export function shortBnb(wei: bigint | string | number): string {
  return `${formatBnb(wei, 4)} BNB`;
}
