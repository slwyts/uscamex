// Persisted operator/RPC settings shared across the panel.
const KEY = "uscamex-admin-settings-v2";
export const SETTINGS_CHANGED_EVENT = "uscamex-settings-changed";

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

const MAINNET_RPC = "https://bsc-dataseed.binance.org";
const TESTNET_RPC = "https://bsc-testnet-rpc.publicnode.com";

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
  chain_id: number;
  token_address: string;
}

/**
 * Sync chainId/tokenAddress from the backend `/api/health` endpoint so the
 * panel automatically tracks whichever chain the operator is wired to
 * (mainnet 56 vs testnet 97). Returns true when local settings were updated.
 */
export async function bootstrapSettingsFromBackend(): Promise<boolean> {
  const current = loadSettings();
  const base = (current.apiBase || "").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/api/health`, { cache: "no-store" });
    if (!res.ok) return false;
    const health = (await res.json()) as Partial<BackendHealth>;
    if (!health || typeof health.chain_id !== "number" || typeof health.token_address !== "string") {
      return false;
    }
    const chainId = health.chain_id;
    const tokenAddress = health.token_address;
    let rpcUrl = current.rpcUrl;
    // If the saved RPC is empty or its mainnet/testnet default contradicts the
    // backend chain id, switch to a sensible default for the active chain.
    if (
      !rpcUrl ||
      (chainId === 97 && rpcUrl === MAINNET_RPC) ||
      (chainId === 56 && rpcUrl === TESTNET_RPC)
    ) {
      rpcUrl = chainId === 97 ? TESTNET_RPC : MAINNET_RPC;
    }
    const next: OperatorSettings = { ...current, chainId, tokenAddress, rpcUrl };
    if (
      next.chainId !== current.chainId ||
      next.tokenAddress.toLowerCase() !== current.tokenAddress.toLowerCase() ||
      next.rpcUrl !== current.rpcUrl
    ) {
      saveSettings(next);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
