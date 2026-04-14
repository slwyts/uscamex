import { ethers, network } from "hardhat";

/**
 * Increase time by a given number of seconds
 */
export async function increaseTime(seconds: number): Promise<void> {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}

/**
 * Fast forward 6 hours (one settlement period)
 */
export async function increaseTimeToNextSettlement(): Promise<void> {
  const SETTLEMENT_INTERVAL = 6 * 60 * 60; // 6 hours
  await increaseTime(SETTLEMENT_INTERVAL);
}

/**
 * Fast forward 1 hour
 */
export async function increaseTimeOneHour(): Promise<void> {
  await increaseTime(60 * 60);
}

/**
 * Fast forward 1 minute
 */
export async function increaseTimeOneMinute(): Promise<void> {
  await increaseTime(60);
}

/**
 * Fast forward 1 day
 */
export async function increaseTimeOneDay(): Promise<void> {
  await increaseTime(24 * 60 * 60);
}

/**
 * Get current block timestamp
 */
export async function getCurrentTimestamp(): Promise<number> {
  const block = await ethers.provider.getBlock("latest");
  return block!.timestamp;
}

/**
 * Set the time to a specific timestamp
 */
export async function setTime(timestamp: number): Promise<void> {
  await network.provider.send("evm_setNextBlockTimestamp", [timestamp]);
  await network.provider.send("evm_mine");
}

/**
 * Mine a number of blocks
 */
export async function mineBlocks(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await network.provider.send("evm_mine");
  }
}
