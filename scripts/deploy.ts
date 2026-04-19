import hre from "hardhat";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const { ethers, network } = hre;

const ROUTER_BY_CHAIN_ID: Record<number, string> = {
  56: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
  97: "0xD99D1c33F9fC3444f8101754aBC46c52416550D1",
};

function requireAddress(name: string): string {
  const value = process.env[name];
  if (!value || !ethers.isAddress(value)) {
    throw new Error(`Missing or invalid ${name}`);
  }
  return value;
}

function getRouterAddress(chainId: number): string {
  const override = process.env.PANCAKE_ROUTER;
  if (override) {
    if (!ethers.isAddress(override)) {
      throw new Error("Invalid PANCAKE_ROUTER");
    }
    return override;
  }

  const router = ROUTER_BY_CHAIN_ID[chainId];
  if (!router) {
    throw new Error(`Unsupported chainId ${chainId} for automatic router selection`);
  }

  return router;
}

function getInitialLiquidity(): bigint {
  return ethers.parseEther(process.env.INITIAL_LIQUIDITY_BNB || "10");
}

function getOperationMode(): number | null {
  const value = process.env.OPERATION_MODE;
  if (value === undefined) {
    return null;
  }

  const parsed = Number(value);
  if (parsed !== 0 && parsed !== 1) {
    throw new Error("OPERATION_MODE must be 0 (NODE_SALE) or 1 (DEPOSIT)");
  }

  return parsed;
}

function getBuyEnabled(): boolean | null {
  const value = process.env.BUY_ENABLED;
  if (value === undefined) {
    return null;
  }

  return value === "true";
}

async function saveDeployment(networkName: string, deployment: Record<string, unknown>) {
  const outputDir = path.join(process.cwd(), "deployments");
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    path.join(outputDir, `${networkName}.json`),
    `${JSON.stringify(deployment, null, 2)}\n`,
    "utf8"
  );
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const { chainId } = await ethers.provider.getNetwork();

  const dividendPool = requireAddress("DIVIDEND_POOL");
  const ecosystemFund = requireAddress("ECOSYSTEM_FUND");
  const buybackWallet = requireAddress("BUYBACK_WALLET");
  const routerAddress = getRouterAddress(Number(chainId));
  const initialLiquidity = getInitialLiquidity();

  console.log(`Deploying to network=${network.name}, chainId=${chainId}`);
  console.log(`Deployer=${deployer.address}`);
  console.log(`Router=${routerAddress}`);
  console.log(`InitialLiquidityBNB=${ethers.formatEther(initialLiquidity)}`);

  const Manager = await ethers.getContractFactory("USCAMEXManager");
  const manager = await Manager.deploy(dividendPool, ecosystemFund, buybackWallet);
  await manager.waitForDeployment();

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

  await (await manager.setTokenContract(await token.getAddress())).wait();
  await (await rewardEngine.setTokenContract(await token.getAddress())).wait();
  await (await token.createPairAndAddLiquidity({ value: initialLiquidity })).wait();

  const operationMode = getOperationMode();
  if (operationMode !== null) {
    await (await manager.setOperationMode(operationMode)).wait();
  }

  const buyEnabled = getBuyEnabled();
  if (buyEnabled !== null) {
    await (await manager.setBuyEnabled(buyEnabled)).wait();
  }

  const deployment = {
    network: network.name,
    chainId: Number(chainId),
    deployer: deployer.address,
    router: routerAddress,
    dividendPool,
    ecosystemFund,
    buybackWallet,
    manager: await manager.getAddress(),
    rewardEngine: await rewardEngine.getAddress(),
    token: await token.getAddress(),
    pair: await token.pair(),
    swapReceiver: await token.swapReceiver(),
    initialLiquidityBNB: ethers.formatEther(initialLiquidity),
    operationMode: operationMode ?? Number(await manager.operationMode()),
    buyEnabled: buyEnabled ?? Boolean(await manager.buyEnabled()),
  };

  await saveDeployment(network.name, deployment);

  console.log("Deployment complete:");
  console.log(JSON.stringify(deployment, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});