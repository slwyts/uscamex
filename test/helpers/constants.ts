import hre from "hardhat";

const { ethers } = hre;

// Test constants for USCAMEX contracts

export const DEFAULT_TAX_CONFIG = {
  buyTaxRate: 300, // 3%
  buyTaxToDividendPool: 3333, // 33.33%
  buyTaxToBuyback: 6667, // 66.67%
  sellTaxRate: 1000, // 10%
  sellTaxToDividendPool: 3000, // 30%
  sellTaxToEcosystem: 3000, // 30%
  sellTaxToBuyback: 4000, // 40%
};

export const DEFAULT_DEPOSIT_CONFIG = {
  minDeposit: ethers.parseEther("0.1"),
  maxDeposit: ethers.parseEther("5"),
  lpPercentage: 6000, // 60%
  nodePercentage: 1000, // 10%
  dividendPoolPercentage: 1000, // 10%
  buybackPercentage: 1000, // 10%
  directReferralPercentage: 1000, // 10%
};

export const DEFAULT_DEFLATION_CONFIG = {
  enabled: true,
  hourlyRate: 10, // 0.1%
  dailyCap: 200, // 2%
};

export const DEFAULT_BUYBACK_CONFIG = {
  active: false,
  perMinuteAmount: ethers.parseEther("0.1"),
};

export const DEFAULT_REWARD_CONFIG = {
  dailyStaticRate: 80, // 0.8%
  exitMultiplier: 300, // 3x
};

export const SETTLEMENT_INTERVAL = 6 * 60 * 60; // 6 hours in seconds

export const BINDING_TRANSFER_AMOUNT = ethers.parseEther("10"); // Exactly 10 tokens

export const TEAM_REWARD_RATES = [1000, 900, 800, 700, 600, 500, 500, 500, 500, 500];
