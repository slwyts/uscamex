/**
 * Worker bindings + settings validation.
 * Port of Token/offchain/src/settings.rs (OperatorSettings).
 *
 * Secrets (set via `wrangler secret put`): RPC_URL, OPERATOR_PRIVATE_KEY.
 * Everything else comes from wrangler.jsonc `vars`.
 */

export interface Env {
  // Bindings
  OPERATOR: DurableObjectNamespace;
  DB: D1Database;
  ASSETS: Fetcher;

  // Secrets
  RPC_URL: string;
  OPERATOR_PRIVATE_KEY: string;

  // Vars (strings from wrangler; parse before use)
  CHAIN_ID: string;
  TOKEN_ADDRESS: string;
  PANCAKE_V2_ROUTER: string;
  BURN_ADDRESS: string;
  CONFIRMATIONS: string;
  INDEXER_START_BLOCK: string;
  EXECUTOR_SLIPPAGE_BPS: string;
  TRANSACTION_DEADLINE_SECONDS: string;
  RPC_MAX_BLOCKS_PER_SCAN: string;
  RPC_CONFIG_TTL_SECS: string;
  RPC_NODES_TTL_SECS: string;
  RPC_RESERVES_TTL_SECS: string;
  RPC_VAULT_BALANCE_TTL_SECS: string;

  // Emergency maintenance guard. When true, the DO keeps its alarm alive but
  // does not scan, plan, or submit any chain command.
  OPERATOR_MAINTENANCE_PAUSED?: string;

  // AMM swap fee in bps-of-input kept after fee (Uniswap V2 numerator).
  // PancakeSwap V2 = 9975 (0.25%); QuickSwap/SushiSwap V2 = 9970 (0.30%).
  // Optional; the operator also tries to auto-detect from the pair when possible.
  AMM_FEE_BPS?: string;

  // --- Chain metadata for admin frontend ---
  PUBLIC_RPC_URL?: string;
  CHAIN_NAME?: string;
  EXPLORER_URL?: string;
  NATIVE_CURRENCY_NAME?: string;
  NATIVE_CURRENCY_SYMBOL?: string;
  NATIVE_CURRENCY_DECIMALS?: string;
}

export interface OperatorSettings {
  rpcUrl: string;
  operatorPrivateKey: `0x${string}`;
  chainId: number;
  tokenAddress: `0x${string}`;
  pancakeV2Router: `0x${string}`;
  burnAddress: `0x${string}`;
  confirmations: number;
  indexerStartBlock: bigint;
  executorSlippageBps: number;
  transactionDeadlineSeconds: number;
  rpcMaxBlocksPerScan: bigint;
  rpcConfigTtlSecs: number;
  rpcNodesTtlSecs: number;
  rpcReservesTtlSecs: number;
  rpcVaultBalanceTtlSecs: number;
  /** AMM fee numerator (kept-after-fee bps). Default 9970 (0.30%, QuickSwap/Sushi). */
  ammFeeBps: number;

  // Chain metadata for admin frontend
  chainName: string;
  publicRpcUrl: string;
  explorerUrl: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const PRIVKEY_RE = /^0x[0-9a-fA-F]{64}$/;

function requireAddress(name: string, value: string): `0x${string}` {
  if (!ADDRESS_RE.test(value)) {
    throw new SettingsError(`${name} must be a 0x-prefixed 40-hex address, got: ${value}`);
  }
  return value.toLowerCase() as `0x${string}`;
}

function requirePosInt(name: string, value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new SettingsError(`${name} must be a non-negative integer, got: ${value}`);
  }
  return n;
}

export class SettingsError extends Error {}

/** Parse + validate env into settings. Mirrors settings.rs validate(). */
export function loadSettings(env: Env): OperatorSettings {
  if (!env.RPC_URL) throw new SettingsError("RPC_URL is required");

  let key = env.OPERATOR_PRIVATE_KEY ?? "";
  if (!key.startsWith("0x")) key = `0x${key}`;
  if (!PRIVKEY_RE.test(key)) {
    throw new SettingsError("OPERATOR_PRIVATE_KEY must be 0x + 64 hex");
  }

  const chainId = requirePosInt("CHAIN_ID", env.CHAIN_ID);
  // Supported EVM chains: BSC (56/97) and Polygon (137 / Amoy 80002).
  const SUPPORTED_CHAINS = [56, 97, 137, 80002];
  if (!SUPPORTED_CHAINS.includes(chainId)) {
    throw new SettingsError(
      `CHAIN_ID must be one of ${SUPPORTED_CHAINS.join(", ")} (BSC/Polygon), got: ${chainId}`,
    );
  }

  const slippage = requirePosInt("EXECUTOR_SLIPPAGE_BPS", env.EXECUTOR_SLIPPAGE_BPS);
  if (slippage > 500) {
    throw new SettingsError("EXECUTOR_SLIPPAGE_BPS must be <= 500");
  }

  // AMM fee numerator. Default by chain: BSC → PancakeSwap 9975; Polygon → QuickSwap 9970.
  // AMM_FEE_BPS overrides; must be in (9000, 10000].
  let ammFeeBps = chainId === 56 || chainId === 97 ? 9975 : 9970;
  if (env.AMM_FEE_BPS && env.AMM_FEE_BPS.length > 0) {
    const v = requirePosInt("AMM_FEE_BPS", env.AMM_FEE_BPS);
    if (v <= 9000 || v > 10_000) {
      throw new SettingsError("AMM_FEE_BPS must be in (9000, 10000]");
    }
    ammFeeBps = v;
  }

  return {
    rpcUrl: env.RPC_URL,
    operatorPrivateKey: key as `0x${string}`,
    chainId,
    tokenAddress: requireAddress("TOKEN_ADDRESS", env.TOKEN_ADDRESS),
    pancakeV2Router: requireAddress("PANCAKE_V2_ROUTER", env.PANCAKE_V2_ROUTER),
    burnAddress: requireAddress("BURN_ADDRESS", env.BURN_ADDRESS),
    confirmations: Math.max(1, requirePosInt("CONFIRMATIONS", env.CONFIRMATIONS)),
    indexerStartBlock: BigInt(requirePosInt("INDEXER_START_BLOCK", env.INDEXER_START_BLOCK)),
    executorSlippageBps: slippage,
    transactionDeadlineSeconds: requirePosInt(
      "TRANSACTION_DEADLINE_SECONDS",
      env.TRANSACTION_DEADLINE_SECONDS,
    ),
    rpcMaxBlocksPerScan: BigInt(
      Math.max(1, requirePosInt("RPC_MAX_BLOCKS_PER_SCAN", env.RPC_MAX_BLOCKS_PER_SCAN)),
    ),
    rpcConfigTtlSecs: requirePosInt("RPC_CONFIG_TTL_SECS", env.RPC_CONFIG_TTL_SECS),
    rpcNodesTtlSecs: requirePosInt("RPC_NODES_TTL_SECS", env.RPC_NODES_TTL_SECS),
    rpcReservesTtlSecs: requirePosInt("RPC_RESERVES_TTL_SECS", env.RPC_RESERVES_TTL_SECS),
    rpcVaultBalanceTtlSecs: requirePosInt(
      "RPC_VAULT_BALANCE_TTL_SECS",
      env.RPC_VAULT_BALANCE_TTL_SECS,
    ),
    ammFeeBps,
    chainName: env.CHAIN_NAME || "Unknown Chain",
    publicRpcUrl: env.PUBLIC_RPC_URL || "",
    explorerUrl: env.EXPLORER_URL || "https://polygonscan.com",
    nativeCurrency: {
      name: env.NATIVE_CURRENCY_NAME || "Native Token",
      symbol: env.NATIVE_CURRENCY_SYMBOL || "ETH",
      decimals: requirePosInt("NATIVE_CURRENCY_DECIMALS", env.NATIVE_CURRENCY_DECIMALS || "18"),
    },
  };
}
