export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function normalizeAddress(value: string): string {
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    throw new Error("地址格式错误");
  }
  return `0x${trimmed.slice(2).toLowerCase()}`;
}

export function tryNormalizeAddress(value: string | null | undefined): string {
  if (!value) return "";
  try {
    return normalizeAddress(value);
  } catch {
    return value.toLowerCase();
  }
}

export function shortAddress(value: string | undefined | null): string {
  if (!value) return "-";
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export function isZeroAddress(value: string | undefined | null): boolean {
  if (!value) return true;
  return value.toLowerCase() === ZERO_ADDRESS;
}
