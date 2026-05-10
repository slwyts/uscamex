// Persisted operator/RPC settings shared across the panel.
const KEY = "uscamex-admin-settings-v2";

export interface OperatorSettings {
  apiBase: string;
  rpcUrl: string;
  chainId: number;
  tokenAddress: string;
}

const DEFAULTS: OperatorSettings = {
  apiBase: "",
  rpcUrl: "https://bsc-dataseed.binance.org",
  chainId: 56,
  tokenAddress: "",
};

export function loadSettings(): OperatorSettings {
  if (typeof localStorage === "undefined") return { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<OperatorSettings>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(value: OperatorSettings) {
  localStorage.setItem(KEY, JSON.stringify(value));
}

export function isTokenConfigured(value: OperatorSettings): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value.tokenAddress);
}
