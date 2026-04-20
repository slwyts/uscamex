import { formatEther, formatUnits } from "viem";

export const managerAbi = [
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "operationMode",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "buyEnabled",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "dividendPool",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "ecosystemFund",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "buybackWallet",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "getTaxConfig",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "buyTaxRate", type: "uint256" },
          { name: "buyTaxToDividendPool", type: "uint256" },
          { name: "buyTaxToBuyback", type: "uint256" },
          { name: "sellTaxRate", type: "uint256" },
          { name: "sellTaxToDividendPool", type: "uint256" },
          { name: "sellTaxToEcosystem", type: "uint256" },
          { name: "sellTaxToBuyback", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getDepositConfig",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "minDeposit", type: "uint256" },
          { name: "maxDeposit", type: "uint256" },
          { name: "lpPercentage", type: "uint256" },
          { name: "nodePercentage", type: "uint256" },
          { name: "dividendPoolPercentage", type: "uint256" },
          { name: "buybackPercentage", type: "uint256" },
          { name: "directReferralPercentage", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getDeflationConfig",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "enabled", type: "bool" },
          { name: "hourlyRate", type: "uint256" },
          { name: "dailyCap", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getBuybackConfig",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "active", type: "bool" },
          { name: "perMinuteAmount", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getRewardConfig",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "dailyStaticRate", type: "uint256" },
          { name: "exitMultiplier", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getTotalNodes",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getTotalNodeWeight",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getNodeAddresses",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    type: "function",
    name: "setOperationMode",
    stateMutability: "nonpayable",
    inputs: [{ name: "_mode", type: "uint8" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setBuyEnabled",
    stateMutability: "nonpayable",
    inputs: [{ name: "_enabled", type: "bool" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setTaxConfig",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "_config",
        type: "tuple",
        components: [
          { name: "buyTaxRate", type: "uint256" },
          { name: "buyTaxToDividendPool", type: "uint256" },
          { name: "buyTaxToBuyback", type: "uint256" },
          { name: "sellTaxRate", type: "uint256" },
          { name: "sellTaxToDividendPool", type: "uint256" },
          { name: "sellTaxToEcosystem", type: "uint256" },
          { name: "sellTaxToBuyback", type: "uint256" },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setDepositConfig",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "_config",
        type: "tuple",
        components: [
          { name: "minDeposit", type: "uint256" },
          { name: "maxDeposit", type: "uint256" },
          { name: "lpPercentage", type: "uint256" },
          { name: "nodePercentage", type: "uint256" },
          { name: "dividendPoolPercentage", type: "uint256" },
          { name: "buybackPercentage", type: "uint256" },
          { name: "directReferralPercentage", type: "uint256" },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setDeflationConfig",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "_config",
        type: "tuple",
        components: [
          { name: "enabled", type: "bool" },
          { name: "hourlyRate", type: "uint256" },
          { name: "dailyCap", type: "uint256" },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setBuybackConfig",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "_config",
        type: "tuple",
        components: [
          { name: "active", type: "bool" },
          { name: "perMinuteAmount", type: "uint256" },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setRewardConfig",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "_config",
        type: "tuple",
        components: [
          { name: "dailyStaticRate", type: "uint256" },
          { name: "exitMultiplier", type: "uint256" },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setDividendPool",
    stateMutability: "nonpayable",
    inputs: [{ name: "_pool", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setEcosystemFund",
    stateMutability: "nonpayable",
    inputs: [{ name: "_fund", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setBuybackWallet",
    stateMutability: "nonpayable",
    inputs: [{ name: "_wallet", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "addNode",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_node", type: "address" },
      { name: "_weight", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "removeNode",
    stateMutability: "nonpayable",
    inputs: [{ name: "_node", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "updateNodeWeight",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_node", type: "address" },
      { name: "_weight", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

export const tokenAbi = [
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "pair",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "buybackReserve",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "pendingBuybackTaxTokens",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "pendingEcosystemTaxTokens",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "pendingSellBurnTokens",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "remainingBindingTokens",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "dailyDeflationAmount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "lastDeflationTime",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "lastBuybackTime",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "distributedBindingTokens",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "syncSystemState",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "processTaxRevenue",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "executeDeflation",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "executeBuyback",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "settlePendingSellBurn",
    stateMutability: "nonpayable",
    inputs: [{ name: "maxAmount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setTaxExempt",
    stateMutability: "nonpayable",
    inputs: [
      { name: "account", type: "address" },
      { name: "exempt", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "distributeBindingTokens",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "withdrawBuybackReserve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "rescueTokens",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "rescueBNB",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
] as const;

export const treasuryVaultAbi = [
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "withdrawBNB",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "withdrawToken",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

export function formatBnb(value: bigint) {
  return `${Number(formatEther(value)).toLocaleString("zh-CN", {
    maximumFractionDigits: 6,
  })} BNB`;
}

export function formatToken(value: bigint) {
  return Number(formatUnits(value, 18)).toLocaleString("zh-CN", {
    maximumFractionDigits: 4,
  });
}

export function formatBps(value: bigint | number) {
  const amount = typeof value === "bigint" ? Number(value) : value;
  return `${(amount / 100).toFixed(2)}%`;
}

export function formatTimestamp(value: bigint) {
  if (value === BigInt(0)) {
    return "未触发";
  }
  return new Date(Number(value) * 1000).toLocaleString("zh-CN", {
    hour12: false,
  });
}

export function modeLabel(value: number) {
  return value === 0 ? "节点销售" : "开放入金";
}

export function shortAddress(value: string) {
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}