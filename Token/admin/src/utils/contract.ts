// Solidity 4-byte selectors and ABI encode/decode helpers used by the panel.
export const SELECTORS = {
  owner: "0x8da5cb5b",
  pair: "0xa8aa1b31",
  vault: "0xfbfa77cf",
  initializeLP: "0xa6690cf9",
  getProtocolConfig: "0xed700b3e",
  setProtocolConfig: "0x77745e13",
  nodeCount: "0x6da49b83",
  nodeAt: "0xf927727c",
  setNode: "0xd475b262",
};

export function encodeUint(value: bigint): string {
  if (value < 0n) throw new Error("uint 不能为负数");
  return value.toString(16).padStart(64, "0");
}

export function encodeAddress(value: string): string {
  const cleaned = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]{40}$/.test(cleaned)) throw new Error("地址格式错误");
  return cleaned.toLowerCase().padStart(64, "0");
}

export function decodeAddress(word: string): string {
  const stripped = stripWord(word);
  return `0x${stripped.slice(24)}`;
}

export function decodeUint(word: string): bigint {
  return BigInt(word || "0x0");
}

export function decodeBool(word: string): boolean {
  return decodeUint(word) !== 0n;
}

export function abiWords(value: string): string[] {
  const hex = value.replace(/^0x/, "");
  if (hex.length === 0) return [];
  if (hex.length % 64 !== 0) throw new Error("ABI 数据长度错误");
  return Array.from({ length: hex.length / 64 }, (_, i) =>
    `0x${hex.slice(i * 64, (i + 1) * 64)}`,
  );
}

function stripWord(value: string): string {
  return value.replace(/^0x/, "").padStart(64, "0");
}

// ----- Protocol config codec ----------------------------------------------
export interface ProtocolConfig {
  operator: string;
  buy_tax_bps: number;
  sell_tax_bps: number;
  min_deposit_wei: bigint;
  max_deposit_wei: bigint;
  buy_enabled: boolean;
  lp_build_bps: number;
  node_bps: number;
  builder_buy_bps: number;
  vault_bps: number;
  direct_pool_bps: number;
  direct_reward_bps: number;
  daily_static_bps: number;
  settlement_periods_per_day: number;
  exit_multiple_bps: number;
  team_reward_bps: number[];
  deflation_enabled: boolean;
  deflation_hourly_bps: number;
  deflation_daily_cap_bps: number;
  buyback_enabled: boolean;
  buyback_per_minute_wei: bigint;
  buy_tax_builder_bps: number;
  buy_tax_vault_bps: number;
  sell_tax_builder_bps: number;
  sell_tax_owner_bps: number;
  sell_tax_vault_bps: number;
}

export function decodeProtocolConfig(returnData: string): ProtocolConfig {
  const words = abiWords(returnData);
  if (words.length < 35) throw new Error("链上 getProtocolConfig 返回长度不足");
  return {
    operator: decodeAddress(words[0]),
    buy_tax_bps: Number(decodeUint(words[1])),
    sell_tax_bps: Number(decodeUint(words[2])),
    min_deposit_wei: decodeUint(words[3]),
    max_deposit_wei: decodeUint(words[4]),
    buy_enabled: decodeBool(words[5]),
    lp_build_bps: Number(decodeUint(words[6])),
    node_bps: Number(decodeUint(words[7])),
    builder_buy_bps: Number(decodeUint(words[8])),
    vault_bps: Number(decodeUint(words[9])),
    direct_pool_bps: Number(decodeUint(words[10])),
    direct_reward_bps: Number(decodeUint(words[11])),
    daily_static_bps: Number(decodeUint(words[12])),
    settlement_periods_per_day: Number(decodeUint(words[13])),
    exit_multiple_bps: Number(decodeUint(words[14])),
    team_reward_bps: Array.from({ length: 10 }, (_, i) => Number(decodeUint(words[15 + i]))),
    deflation_enabled: decodeBool(words[25]),
    deflation_hourly_bps: Number(decodeUint(words[26])),
    deflation_daily_cap_bps: Number(decodeUint(words[27])),
    buyback_enabled: decodeBool(words[28]),
    buyback_per_minute_wei: decodeUint(words[29]),
    buy_tax_builder_bps: Number(decodeUint(words[30])),
    buy_tax_vault_bps: Number(decodeUint(words[31])),
    sell_tax_builder_bps: Number(decodeUint(words[32])),
    sell_tax_owner_bps: Number(decodeUint(words[33])),
    sell_tax_vault_bps: Number(decodeUint(words[34])),
  };
}

export function encodeSetProtocolConfig(config: ProtocolConfig): string {
  return (
    SELECTORS.setProtocolConfig +
    encodeAddress(config.operator) +
    encodeUint(BigInt(config.buy_tax_bps)) +
    encodeUint(BigInt(config.sell_tax_bps)) +
    encodeUint(config.min_deposit_wei) +
    encodeUint(config.max_deposit_wei) +
    encodeUint(config.buy_enabled ? 1n : 0n) +
    encodeUint(BigInt(config.lp_build_bps)) +
    encodeUint(BigInt(config.node_bps)) +
    encodeUint(BigInt(config.builder_buy_bps)) +
    encodeUint(BigInt(config.vault_bps)) +
    encodeUint(BigInt(config.direct_pool_bps)) +
    encodeUint(BigInt(config.direct_reward_bps)) +
    encodeUint(BigInt(config.daily_static_bps)) +
    encodeUint(BigInt(config.settlement_periods_per_day)) +
    encodeUint(BigInt(config.exit_multiple_bps)) +
    config.team_reward_bps.map((rate) => encodeUint(BigInt(rate))).join("") +
    encodeUint(config.deflation_enabled ? 1n : 0n) +
    encodeUint(BigInt(config.deflation_hourly_bps)) +
    encodeUint(BigInt(config.deflation_daily_cap_bps)) +
    encodeUint(config.buyback_enabled ? 1n : 0n) +
    encodeUint(config.buyback_per_minute_wei) +
    encodeUint(BigInt(config.buy_tax_builder_bps)) +
    encodeUint(BigInt(config.buy_tax_vault_bps)) +
    encodeUint(BigInt(config.sell_tax_builder_bps)) +
    encodeUint(BigInt(config.sell_tax_owner_bps)) +
    encodeUint(BigInt(config.sell_tax_vault_bps))
  );
}

export function encodeNodeAtCall(index: number): string {
  return SELECTORS.nodeAt + encodeUint(BigInt(index));
}

export function encodeSetNodeCall(address: string, weight: bigint): string {
  return SELECTORS.setNode + encodeAddress(address) + encodeUint(weight);
}
