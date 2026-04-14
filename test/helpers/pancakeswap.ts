import { ethers } from "hardhat";
import { Contract, ContractFactory } from "ethers";

/**
 * Deploy mock PancakeSwap V2 contracts for testing
 * Returns factory, router, and WBNB addresses
 */
export async function deployPancakeSwap(): Promise<{
  factory: Contract;
  router: Contract;
  wbnb: Contract;
}> {
  // Deploy WBNB
  const WBNB = await ethers.getContractFactory("MockWBNB");
  const wbnb = await WBNB.deploy();
  await wbnb.waitForDeployment();

  // Deploy Factory
  const Factory = await ethers.getContractFactory("MockPancakeFactory");
  const factory = await Factory.deploy();
  await factory.waitForDeployment();

  // Deploy Router
  const Router = await ethers.getContractFactory("MockPancakeRouter");
  const router = await Router.deploy(
    await factory.getAddress(),
    await wbnb.getAddress()
  );
  await router.waitForDeployment();

  return { factory, router, wbnb };
}

// Note: The actual mock contracts (MockWBNB, MockPancakeFactory, MockPancakeRouter)
// would need to be implemented as simplified versions of the real contracts.
// For a full implementation, we'd create these mocks in contracts/mocks/ directory.
