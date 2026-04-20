import hre from "hardhat";
import { deployPancakeSwap } from "./pancakeswap.ts";

const { ethers } = hre;

type ContractLike = any;
type SignerLike = any;

export const PANCAKE_V2_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
export const PANCAKE_V2_FACTORY = "0xca143ce32fe78f1f7019d7d551a6402fc5350c73";
export const WBNB_MAINNET = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";

type ManagedVault = {
  address: string;
};

export interface DeploymentResult {
  token: ContractLike;
  manager: ContractLike;
  rewardEngine: ContractLike;
  router: ContractLike;
  factory: ContractLike;
  wbnb: ContractLike;
  pair: ContractLike;
  owner: SignerLike;
  dividendPool: ManagedVault;
  ecosystemFund: ManagedVault;
  buybackWallet: ManagedVault;
}

async function deployManagementContracts(
  routerAddress: string
): Promise<Omit<DeploymentResult, "router" | "factory" | "wbnb" | "pair"> & { token: ContractLike }> {
  const [owner] = await ethers.getSigners();

  const Manager = await ethers.getContractFactory("USCAMEXManager");
  const manager = await Manager.deploy(
    owner.address,
    owner.address,
    owner.address,
    owner.address
  );
  await manager.waitForDeployment();

  const TreasuryVault = await ethers.getContractFactory("TreasuryVault");
  const dividendPoolVault = await TreasuryVault.deploy(await manager.getAddress());
  await dividendPoolVault.waitForDeployment();

  const ecosystemFundVault = await TreasuryVault.deploy(await manager.getAddress());
  await ecosystemFundVault.waitForDeployment();

  const buybackVault = await TreasuryVault.deploy(await manager.getAddress());
  await buybackVault.waitForDeployment();

  await manager.setDividendPool(await dividendPoolVault.getAddress());
  await manager.setEcosystemFund(await ecosystemFundVault.getAddress());
  await manager.setBuybackWallet(await buybackVault.getAddress());

  const RewardEngine = await ethers.getContractFactory("RewardEngine");
  const rewardEngine = await RewardEngine.deploy(await manager.getAddress());
  await rewardEngine.waitForDeployment();

  const Token = await ethers.getContractFactory("USCAMEX");
  const token = await Token.deploy(
    await manager.getAddress(),
    await rewardEngine.getAddress(),
    routerAddress
  );
  await token.waitForDeployment();

  await manager.setTokenContract(await token.getAddress());
  await rewardEngine.setTokenContract(await token.getAddress());

  return {
    token,
    manager,
    rewardEngine,
    owner,
    dividendPool: { address: await dividendPoolVault.getAddress() },
    ecosystemFund: { address: await ecosystemFundVault.getAddress() },
    buybackWallet: { address: await buybackVault.getAddress() },
  };
}

/**
 * Deploy all USCAMEX contracts along with PancakeSwap mocks
 */
export async function deployFullSystem(): Promise<DeploymentResult> {
  const { factory, router, wbnb } = await deployPancakeSwap();
  const deployment = await deployManagementContracts(await router.getAddress());

  // Create pair and add initial liquidity
  const initialBNB = ethers.parseEther("10"); // 10 BNB initial liquidity
  await deployment.token.createPairAndAddLiquidity({ value: initialBNB });

  // Get pair address
  const pairAddress = await factory.getPair(
    await deployment.token.getAddress(),
    await wbnb.getAddress()
  );
  const pair = await ethers.getContractAt("IPancakePair", pairAddress);

  return {
    ...deployment,
    router,
    factory,
    wbnb,
    pair,
  };
}

export async function deployFullSystemOnFork(): Promise<DeploymentResult> {
  const router = await ethers.getContractAt("IPancakeRouter02", PANCAKE_V2_ROUTER);
  const factory = await ethers.getContractAt("IPancakeFactory", PANCAKE_V2_FACTORY);
  const wbnb = await ethers.getContractAt("IERC20", WBNB_MAINNET);
  const deployment = await deployManagementContracts(PANCAKE_V2_ROUTER);

  await deployment.token.createPairAndAddLiquidity({ value: ethers.parseEther("10") });

  const pairAddress = await factory.getPair(
    await deployment.token.getAddress(),
    WBNB_MAINNET
  );
  const pair = await ethers.getContractAt("IPancakePair", pairAddress);

  return {
    ...deployment,
    router,
    factory,
    wbnb,
    pair,
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
