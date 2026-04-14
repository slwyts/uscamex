import { ethers } from "hardhat";
import { Contract } from "ethers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { deployPancakeSwap } from "./pancakeswap";
import {
  DEFAULT_TAX_CONFIG,
  DEFAULT_DEPOSIT_CONFIG,
  DEFAULT_DEFLATION_CONFIG,
  DEFAULT_BUYBACK_CONFIG,
  DEFAULT_REWARD_CONFIG,
} from "./constants";

export interface DeploymentResult {
  token: Contract;
  manager: Contract;
  rewardEngine: Contract;
  router: Contract;
  factory: Contract;
  wbnb: Contract;
  pair: Contract;
  owner: SignerWithAddress;
  dividendPool: SignerWithAddress;
  ecosystemFund: SignerWithAddress;
  buybackWallet: SignerWithAddress;
}

/**
 * Deploy all USCAMEX contracts along with PancakeSwap mocks
 */
export async function deployFullSystem(): Promise<DeploymentResult> {
  const [owner, dividendPool, ecosystemFund, buybackWallet, ...users] =
    await ethers.getSigners();

  // Deploy PancakeSwap
  const { factory, router, wbnb } = await deployPancakeSwap();

  // Deploy Manager
  const Manager = await ethers.getContractFactory("USCAMEXManager");
  const manager = await Manager.deploy(
    dividendPool.address,
    ecosystemFund.address,
    buybackWallet.address
  );
  await manager.waitForDeployment();

  // Deploy RewardEngine
  const RewardEngine = await ethers.getContractFactory("RewardEngine");
  const rewardEngine = await RewardEngine.deploy(await manager.getAddress());
  await rewardEngine.waitForDeployment();

  // Deploy Token
  const Token = await ethers.getContractFactory("USCAMEX");
  const token = await Token.deploy(
    await manager.getAddress(),
    await rewardEngine.getAddress(),
    await router.getAddress()
  );
  await token.waitForDeployment();

  // Set token contract in reward engine
  await rewardEngine.setTokenContract(await token.getAddress());

  // Create pair and add initial liquidity
  const initialBNB = ethers.parseEther("10"); // 10 BNB initial liquidity
  await token.createPairAndAddLiquidity({ value: initialBNB });

  // Get pair address
  const pairAddress = await factory.getPair(
    await token.getAddress(),
    await wbnb.getAddress()
  );
  const pair = await ethers.getContractAt("IPancakePair", pairAddress);

  return {
    token,
    manager,
    rewardEngine,
    router,
    factory,
    wbnb,
    pair,
    owner,
    dividendPool,
    ecosystemFund,
    buybackWallet,
  };
}

/**
 * Deploy with custom configuration
 */
export async function deployWithConfig(
  taxConfig?: any,
  depositConfig?: any,
  deflationConfig?: any,
  buybackConfig?: any,
  rewardConfig?: any
): Promise<DeploymentResult> {
  const deployment = await deployFullSystem();

  // Apply custom configs if provided
  if (taxConfig) {
    await deployment.manager.setTaxConfig(taxConfig);
  }

  if (depositConfig) {
    await deployment.manager.setDepositConfig(depositConfig);
  }

  if (deflationConfig) {
    await deployment.manager.setDeflationConfig(deflationConfig);
  }

  if (buybackConfig) {
    await deployment.manager.setBuybackConfig(buybackConfig);
  }

  if (rewardConfig) {
    await deployment.manager.setRewardConfig(rewardConfig);
  }

  return deployment;
}
