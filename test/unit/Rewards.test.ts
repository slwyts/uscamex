import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { deployFullSystem, deployWithConfig } from "../helpers/deploy";
import { increaseTimeOneDay, increaseTimeToNextSettlement } from "../helpers/time";

const { ethers } = hre;

describe("USCAMEX Rewards", function () {
  async function depositFixture() {
    const deployment = await deployFullSystem();
    await deployment.manager.setOperationMode(1);
    return deployment;
  }

  async function exitFixture() {
    const deployment = await deployWithConfig(undefined, undefined, undefined, undefined, {
      dailyStaticRate: 1000,
      exitMultiplier: 10,
    });
    await deployment.manager.setOperationMode(1);
    return deployment;
  }

  async function fundUserFromTreasury(token: any, recipient: string, amount: bigint) {
    await token.rescueTokens(await token.getAddress(), amount);
    await token.transfer(recipient, amount);
  }

  it("settles and pays static rewards in tokens", async function () {
    const { token, rewardEngine } = await loadFixture(depositFixture);
    const [, , , , user] = await ethers.getSigners();

    await user.sendTransaction({
      to: await token.getAddress(),
      value: ethers.parseEther("1"),
    });

    await increaseTimeToNextSettlement();

    const pendingBeforeClaim = await rewardEngine.getPendingRewards(user.address);
    expect(pendingBeforeClaim[0]).to.be.gt(0);

    const tokenBalanceBefore = await token.balanceOf(user.address);
    await token.connect(user).claimRewards();
    const tokenBalanceAfter = await token.balanceOf(user.address);

    expect(tokenBalanceAfter).to.be.gt(tokenBalanceBefore);

    const pendingAfterClaim = await rewardEngine.getPendingRewards(user.address);
    expect(pendingAfterClaim[0]).to.equal(0);
  });

  it("accrues dynamic rewards when downline settles static rewards", async function () {
    const { token, rewardEngine, owner } = await loadFixture(depositFixture);
    const [, , , , parent, child] = await ethers.getSigners();

    const bindingAmount = ethers.parseEther("10");
    const fundingAmount = ethers.parseEther("20");

    await fundUserFromTreasury(token, parent.address, fundingAmount);
    await token.connect(parent).transfer(owner.address, bindingAmount);

    await fundUserFromTreasury(token, child.address, fundingAmount);
    await token.connect(child).transfer(parent.address, bindingAmount);

    await parent.sendTransaction({
      to: await token.getAddress(),
      value: ethers.parseEther("1"),
    });

    await child.sendTransaction({
      to: await token.getAddress(),
      value: ethers.parseEther("1"),
    });

    await increaseTimeToNextSettlement();

    await token.connect(child).claimRewards();

    const parentPending = await rewardEngine.getPendingRewards(parent.address);
    expect(parentPending[1]).to.be.gt(0);

    const parentTokenBalanceBefore = await token.balanceOf(parent.address);
    await token.connect(parent).claimRewards();
    const parentTokenBalanceAfter = await token.balanceOf(parent.address);

    expect(parentTokenBalanceAfter).to.be.gt(parentTokenBalanceBefore);
  });

  it("automatically closes the LP position after exit is reached", async function () {
    const { token, rewardEngine } = await loadFixture(exitFixture);
    const [, , , , user] = await ethers.getSigners();

    await user.sendTransaction({
      to: await token.getAddress(),
      value: ethers.parseEther("1"),
    });

    expect(await token.userLpShares(user.address)).to.be.gt(0);

    await increaseTimeOneDay();

    const rewardTokenBalanceBefore = await token.balanceOf(user.address);
    await token.connect(user).claimRewards();
    const rewardTokenBalanceAfter = await token.balanceOf(user.address);

    expect(rewardTokenBalanceAfter).to.be.gt(rewardTokenBalanceBefore);
    expect(await token.userLpShares(user.address)).to.equal(0);

    const userInfo = await rewardEngine.getUserInfo(user.address);
    expect(userInfo.depositAmount).to.equal(0);
    expect(await rewardEngine.hasExited(user.address)).to.equal(true);
  });

  it("allows a user to withdraw the full LP position and stop the cycle", async function () {
    const { token, rewardEngine } = await loadFixture(depositFixture);
    const [, , , , user] = await ethers.getSigners();

    await user.sendTransaction({
      to: await token.getAddress(),
      value: ethers.parseEther("1"),
    });

    await increaseTimeToNextSettlement();

    const lpShares = await token.userLpShares(user.address);
    expect(lpShares).to.be.gt(0);

    await token.connect(user).withdrawMyLP();

    expect(await token.userLpShares(user.address)).to.equal(0);

    const userInfo = await rewardEngine.getUserInfo(user.address);
    expect(userInfo.depositAmount).to.equal(0);
    expect(await rewardEngine.hasExited(user.address)).to.equal(true);
  });
});