// Persisted settings. Chain metadata comes from the backend /api/health;
// only `apiBase` is user-configurable (defaults to current origin).

const KEY = "uscamex-admin-settings-v3";
export const SETTINGS_CHANGED_EVENT = "uscamex-settings-changed";

export interface ChainConfig {
  id: number;
  name: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrl: string;
  explorerUrl: string;
}

export interface OperatorSettings {
  apiBase: string;
  chainConfig: ChainConfig;
  tokenAddress: string;
}

const DEFAULT_CHAIN: ChainConfig = {
  id: 0,
  name: "等待同步...",
  nativeCurrency: { name: "Native Token", symbol: "ETH", decimals: 18 },
  rpcUrl: "",
  explorerUrl: "",
};

const DEFAULTS: OperatorSettings = {
  apiBase: "",
  chainConfig: { ...DEFAULT_CHAIN },
  tokenAddress: "",
};

export function loadSettings(): OperatorSettings {
  if (typeof localStorage === "undefined") return { ...DEFAULTS, chainConfig: { ...DEFAULT_CHAIN } };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS, chainConfig: { ...DEFAULT_CHAIN } };
    const parsed = JSON.parse(raw) as Partial<OperatorSettings>;
    return {
      apiBase: parsed.apiBase ?? DEFAULTS.apiBase,
      chainConfig: parsed.chainConfig ? { ...DEFAULT_CHAIN, ...parsed.chainConfig } : { ...DEFAULT_CHAIN },
      tokenAddress: parsed.tokenAddress ?? DEFAULTS.tokenAddress,
    };
  } catch {
    return { ...DEFAULTS, chainConfig: { ...DEFAULT_CHAIN } };
  }
}

export function saveSettings(value: OperatorSettings) {
  localStorage.setItem(KEY, JSON.stringify(value));
  try {
    window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT));
  } catch {
    // ignore
  }
}

export function isTokenConfigured(value: OperatorSettings): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value.tokenAddress);
}

interface BackendHealth {
  ok: boolean;
  chain: {
    id: number;
    name: string;
    native_currency: { name: string; symbol: string; decimals: number };
    rpc_url: string;
    explorer_url: string;
  };
  token_address: string;
  pancake_v2_router?: string;
  chain_head?: number | null;
  indexer_start_block?: number;
  confirmations?: number;
}

/**
 * Sync ALL settings (chain config, token address) from the backend
 * /api/health endpoint. Only `apiBase` survives user configuration.
 * Returns true when local settings were updated.
 */
export async function bootstrapSettingsFromBackend(): Promise<boolean> {
  const current = loadSettings();
  const base = (current.apiBase || "").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/api/health`, { cache: "no-store" });
    if (!res.ok) return false;
    const health = (await res.json()) as Partial<BackendHealth>;
    if (
      !health?.chain ||
      typeof health.chain.id !== "number" ||
      typeof health.token_address !== "string"
    ) {
      return false;
    }
    const chainConfig: ChainConfig = {
      id: health.chain.id,
      name: health.chain.name || `Chain ${health.chain.id}`,
      nativeCurrency: health.chain.native_currency ?? { name: "ETH", symbol: "ETH", decimals: 18 },
      rpcUrl: health.chain.rpc_url || "",
      explorerUrl: health.chain.explorer_url || "",
    };
    const tokenAddress = health.token_address.toLowerCase();
    const next: OperatorSettings = { ...current, chainConfig, tokenAddress };
    if (
      next.chainConfig.id !== current.chainConfig.id ||
      next.chainConfig.rpcUrl !== current.chainConfig.rpcUrl ||
      next.tokenAddress !== current.tokenAddress
    ) {
      saveSettings(next);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
