import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "dotenv/config";

const forkUrl = process.env.BSC_RPC_URL;
const forkBlockNumber = process.env.BSC_FORK_BLOCK
  ? Number(process.env.BSC_FORK_BLOCK)
  : undefined;
const bscTestnetUrl = process.env.BSC_TESTNET_RPC_URL || "https://data-seed-prebsc-1-s1.binance.org:8545";
const bscMainnetUrl = process.env.BSC_MAINNET_RPC_URL || "https://bsc-dataseed.binance.org/";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    hardhat: {
      chainId: 56,
      accounts: {
        count: 50,
      },
      forking: forkUrl
        ? {
            url: forkUrl,
            blockNumber: forkBlockNumber,
          }
        : undefined,
    },
    bscTestnet: {
      url: bscTestnetUrl,
      chainId: 97,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    bsc: {
      url: bscMainnetUrl,
      chainId: 56,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },
  gasReporter: {
    enabled: !forkUrl,
    currency: "USD",
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};

export default config;
