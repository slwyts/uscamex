import { describe, expect, it } from "vitest";
import { loadSettings, SettingsError, type Env } from "../src/env";

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    OPERATOR: {} as DurableObjectNamespace,
    DB: {} as D1Database,
    ASSETS: {} as Fetcher,
    RPC_URL: "https://rpc.example",
    OPERATOR_PRIVATE_KEY: `0x${"1".repeat(64)}`,
    CHAIN_ID: "56",
    TOKEN_ADDRESS: `0x${"2".repeat(40)}`,
    PANCAKE_V2_ROUTER: `0x${"3".repeat(40)}`,
    BURN_ADDRESS: "0x000000000000000000000000000000000000dEaD",
    CONFIRMATIONS: "1",
    INDEXER_START_BLOCK: "1",
    EXECUTOR_SLIPPAGE_BPS: "500",
    TRANSACTION_DEADLINE_SECONDS: "600",
    RPC_MAX_BLOCKS_PER_SCAN: "1000",
    RPC_CONFIG_TTL_SECS: "300",
    RPC_NODES_TTL_SECS: "60",
    RPC_RESERVES_TTL_SECS: "30",
    RPC_VAULT_BALANCE_TTL_SECS: "30",
    NATIVE_CURRENCY_DECIMALS: "18",
    ...overrides,
  };
}

describe("env settings", () => {
  it("accepts the maximum MEV slippage guard", () => {
    expect(loadSettings(baseEnv()).executorSlippageBps).toBe(500);
  });

  it("rejects slippage that would weaken LP min protection", () => {
    expect(() => loadSettings(baseEnv({ EXECUTOR_SLIPPAGE_BPS: "501" }))).toThrow(SettingsError);
  });
});
