import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { deployFullSystem, deployWithConfig } from "../helpers/deploy.ts";
import {
  increaseTimeOneMinute,
  increaseTimeOneHour,
  increaseTimeOneDay,
  increaseTimeToNextSettlement,
} from "../helpers/time.ts";

const { ethers } = hre;

describe("USCAMEX README Coverage", function () {
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

  it("distributes node rewards by weight when a user deposits", async function () {
    const { token, manager } = await loadFixture(depositFixture);
    const [, , , , nodeA, nodeB, depositor] = await ethers.getSigners();

    await manager.addNode(nodeA.address, ethers.parseEther("2"));
    await manager.addNode(nodeB.address, ethers.parseEther("3"));

    const nodeABalanceBefore = await ethers.provider.getBalance(nodeA.address);
    const nodeBBalanceBefore = await ethers.provider.getBalance(nodeB.address);

    await depositor.sendTransaction({
      to: await token.getAddress(),
      value: ethers.parseEther("1"),
    });

    expect(await ethers.provider.getBalance(nodeA.address)).to.equal(
      nodeABalanceBefore + ethers.parseEther("0.04")
    );
    expect(await ethers.provider.getBalance(nodeB.address)).to.equal(
      nodeBBalanceBefore + ethers.parseEther("0.06")
    );
  });

  it("accumulates deposit amount, node weight, and LP shares across multiple deposits", async function () {
    const { token, manager, rewardEngine } = await loadFixture(depositFixture);
    const [, , , , user] = await ethers.getSigners();

    await user.sendTransaction({
      to: await token.getAddress(),
      value: ethers.parseEther("1"),
    });

    const lpSharesAfterFirstDeposit = await token.userLpShares(user.address);

    await user.sendTransaction({
      to: await token.getAddress(),
      value: ethers.parseEther("0.5"),
    });

    await user.sendTransaction({
      to: await token.getAddress(),
      value: ethers.parseEther("0.2"),
    });

    const userInfo = await rewardEngine.getUserInfo(user.address);

    expect(userInfo.depositAmount).to.equal(ethers.parseEther("1.7"));
    expect(await manager.nodeWeight(user.address)).to.equal(ethers.parseEther("1.7"));
    expect(await token.userLpShares(user.address)).to.be.gt(lpSharesAfterFirstDeposit);
  });

  it("rejects binding to a referrer that is not already in the referral tree", async function () {
    const { token, rewardEngine } = await loadFixture(depositFixture);
    const [, , , , user, unboundReferrer] = await ethers.getSigners();

    await fundUserFromTreasury(token, user.address, ethers.parseEther("20"));

    await expect(
      token.connect(user).transfer(unboundReferrer.address, ethers.parseEther("10"))
    ).to.be.revertedWith("Referrer must be in tree");

    expect(await rewardEngine.getReferrer(user.address)).to.equal(ethers.ZeroAddress);
  });

  it("does not trigger referral binding when exactly 10 tokens are sent to a contract address", async function () {
    const { token, rewardEngine } = await loadFixture(depositFixture);
    const [, , , , user] = await ethers.getSigners();

    await fundUserFromTreasury(token, user.address, ethers.parseEther("20"));

    await token.connect(user).transfer(await rewardEngine.getAddress(), ethers.parseEther("10"));

    expect(await rewardEngine.getReferrer(user.address)).to.equal(ethers.ZeroAddress);
    expect(await token.balanceOf(await rewardEngine.getAddress())).to.equal(ethers.parseEther("10"));
  });

  it("applies a new static reward rate on the next settlement window", async function () {
    const { token, manager, rewardEngine } = await loadFixture(depositFixture);
    const [, , , , user] = await ethers.getSigners();

    await user.sendTransaction({
      to: await token.getAddress(),
      value: ethers.parseEther("1"),
    });

    await increaseTimeToNextSettlement();

    const pendingBeforeRateChange = await rewardEngine.getPendingRewards(user.address);
    expect(pendingBeforeRateChange[0]).to.equal(ethers.parseEther("0.002"));

    await token.connect(user).claimRewards();

    await manager.setRewardConfig({
      dailyStaticRate: 160,
      exitMultiplier: 300,
    });

    await increaseTimeToNextSettlement();

    const pendingAfterRateChange = await rewardEngine.getPendingRewards(user.address);
    expect(pendingAfterRateChange[0]).to.equal(ethers.parseEther("0.004"));
  });

  it("applies the latest static reward rate immediately within an unclaimed settlement window", async function () {
    const { token, manager, rewardEngine } = await loadFixture(depositFixture);
    const [, , , , user] = await ethers.getSigners();

    await user.sendTransaction({
      to: await token.getAddress(),
      value: ethers.parseEther("1"),
    });

    await increaseTimeOneHour();

    await manager.setRewardConfig({
      dailyStaticRate: 160,
      exitMultiplier: 300,
    });

    await increaseTimeOneHour();
    await increaseTimeOneHour();
    await increaseTimeOneHour();
    await increaseTimeOneHour();
    await increaseTimeOneHour();

    const pendingRewards = await rewardEngine.getPendingRewards(user.address);
    expect(pendingRewards[0]).to.equal(ethers.parseEther("0.004"));
  });

  it("routes reduced direct referral allocation into buyback reserve through the next deposit config", async function () {
    const { token, manager, rewardEngine } = await loadFixture(depositFixture);
    const [, , , , parent, child, nodeHolder] = await ethers.getSigners();

    await manager.addNode(nodeHolder.address, ethers.parseEther("1"));

    await fundUserFromTreasury(token, parent.address, ethers.parseEther("20"));
    await token.connect(parent).transfer((await ethers.getSigners())[0].address, ethers.parseEther("10"));

    await fundUserFromTreasury(token, child.address, ethers.parseEther("20"));
    await token.connect(child).transfer(parent.address, ethers.parseEther("10"));

    expect(await rewardEngine.getReferrer(child.address)).to.equal(parent.address);

    await manager.setDepositConfig({
      minDeposit: ethers.parseEther("0.1"),
      maxDeposit: ethers.parseEther("5"),
      lpPercentage: 6000,
      nodePercentage: 1000,
      dividendPoolPercentage: 1000,
      buybackPercentage: 1500,
      directReferralPercentage: 500,
    });

    const parentBalanceBefore = await ethers.provider.getBalance(parent.address);

    await child.sendTransaction({
      to: await token.getAddress(),
      value: ethers.parseEther("1"),
    });

    expect(await ethers.provider.getBalance(parent.address)).to.equal(
      parentBalanceBefore + ethers.parseEther("0.05")
    );
    expect(await token.buybackReserve()).to.equal(ethers.parseEther("0.15"));
  });

  it("stops deflation after the daily cap is reached", async function () {
    const { token, manager, dividendPool } = await loadFixture(depositFixture);

    await manager.setDeflationConfig({
      enabled: true,
      hourlyRate: 200,
      dailyCap: 200,
    });

    const dividendPoolBalanceBefore = await token.balanceOf(dividendPool.address);

    await increaseTimeOneHour();
    await token.executeDeflation();

    expect(await token.balanceOf(dividendPool.address)).to.be.gt(dividendPoolBalanceBefore);

    await increaseTimeOneHour();

    await expect(token.executeDeflation()).to.be.revertedWith("Deflation not ready");
  });

  it("lets a user rejoin after exit and restores the active cycle state", async function () {
    const { token, rewardEngine, manager } = await loadFixture(exitFixture);
    const [, , , , user] = await ethers.getSigners();

    await user.sendTransaction({
      to: await token.getAddress(),
      value: ethers.parseEther("1"),
    });

    await increaseTimeOneDay();
    await token.connect(user).claimRewards();

    expect(await rewardEngine.hasExited(user.address)).to.equal(true);
    expect(await manager.isNode(user.address)).to.equal(false);

    await user.sendTransaction({
      to: await token.getAddress(),
      value: ethers.parseEther("0.5"),
    });

    const userInfo = await rewardEngine.getUserInfo(user.address);

    expect(await rewardEngine.hasExited(user.address)).to.equal(false);
    expect(await manager.isNode(user.address)).to.equal(true);
    expect(userInfo.depositAmount).to.equal(ethers.parseEther("0.5"));
  });

  it("stops propagating future dynamic rewards to an ancestor after that ancestor exits", async function () {
    const { token, rewardEngine, owner } = await loadFixture(exitFixture);
    const [, , , , ancestor, parent, child] = await ethers.getSigners();

    for (const account of [ancestor, parent, child]) {
      await fundUserFromTreasury(token, account.address, ethers.parseEther("20"));
    }

    await token.connect(ancestor).transfer(owner.address, ethers.parseEther("10"));
    await token.connect(parent).transfer(ancestor.address, ethers.parseEther("10"));
    await token.connect(child).transfer(parent.address, ethers.parseEther("10"));

    await ancestor.sendTransaction({
      to: await token.getAddress(),
      value: ethers.parseEther("1"),
    });

    await parent.sendTransaction({
      to: await token.getAddress(),
      value: ethers.parseEther("1"),
    });

    await child.sendTransaction({
      to: await token.getAddress(),
      value: ethers.parseEther("1"),
    });

    await increaseTimeOneDay();
    await token.connect(ancestor).claimRewards();

    expect(await rewardEngine.hasExited(ancestor.address)).to.equal(true);

    await increaseTimeToNextSettlement();
    await token.connect(child).claimRewards();

    const ancestorPending = await rewardEngine.getPendingRewards(ancestor.address);
    const parentPending = await rewardEngine.getPendingRewards(parent.address);

    expect(ancestorPending[1]).to.equal(0);
    expect(parentPending[1]).to.be.gt(0);
  });

  it("unlocks second-generation dynamic rewards only after the user has enough direct referrals", async function () {
    const { token, rewardEngine, owner } = await loadFixture(depositFixture);
    const [, , , , accountA, accountB, accountC, accountD] = await ethers.getSigners();

    for (const account of [accountA, accountB, accountC, accountD]) {
      await fundUserFromTreasury(token, account.address, ethers.parseEther("20"));
    }

    await token.connect(accountA).transfer(owner.address, ethers.parseEther("10"));
    await token.connect(accountB).transfer(accountA.address, ethers.parseEther("10"));
    await token.connect(accountD).transfer(accountA.address, ethers.parseEther("10"));
    await token.connect(accountC).transfer(accountB.address, ethers.parseEther("10"));

    await accountA.sendTransaction({
      to: await token.getAddress(),
      value: ethers.parseEther("1"),
    });

    await accountB.sendTransaction({
      to: await token.getAddress(),
      value: ethers.parseEther("1"),
    });

    await accountC.sendTransaction({
      to: await token.getAddress(),
      value: ethers.parseEther("1"),
    });

    await increaseTimeToNextSettlement();
    await token.connect(accountC).claimRewards();

    const pendingForB = await rewardEngine.getPendingRewards(accountB.address);
    const pendingForA = await rewardEngine.getPendingRewards(accountA.address);

    expect(pendingForB[1]).to.equal(ethers.parseEther("0.0002"));
    expect(pendingForA[1]).to.equal(ethers.parseEther("0.00018"));
  });

  it("reaches the tenth generation reward when the ancestor has ten direct referrals unlocked", async function () {
    const { token, rewardEngine, owner } = await loadFixture(depositFixture);
    const signers = await ethers.getSigners();
    const rootAncestor = signers[4];
    const chainUsers = signers.slice(5, 14);
    const leafUser = signers[14];
    const fillerDirects = signers.slice(15, 24);

    for (const account of [rootAncestor, ...chainUsers, leafUser, ...fillerDirects]) {
      await fundUserFromTreasury(token, account.address, ethers.parseEther("20"));
    }

    await token.connect(rootAncestor).transfer(owner.address, ethers.parseEther("10"));

    let currentReferrer = rootAncestor;
    for (const account of chainUsers) {
      await token.connect(account).transfer(currentReferrer.address, ethers.parseEther("10"));
      currentReferrer = account;
    }

    await token.connect(leafUser).transfer(chainUsers[chainUsers.length - 1].address, ethers.parseEther("10"));

    for (const filler of fillerDirects) {
      await token.connect(filler).transfer(rootAncestor.address, ethers.parseEther("10"));
    }

    expect(await rewardEngine.getDirectReferralCount(rootAncestor.address)).to.equal(10);

    for (const account of [rootAncestor, ...chainUsers, leafUser]) {
      await account.sendTransaction({
        to: await token.getAddress(),
        value: ethers.parseEther("1"),
      });
    }

    await increaseTimeToNextSettlement();
    await token.connect(leafUser).claimRewards();

    const pendingForTenthGeneration = await rewardEngine.getPendingRewards(rootAncestor.address);
    expect(pendingForTenthGeneration[1]).to.equal(ethers.parseEther("0.0001"));
  });

  it("burns the excess part above 10 percent when sell tax is configured higher than the README base", async function () {
    const { token, manager, router, wbnb, dividendPool } = await loadFixture(depositFixture);
    const [, , , , seller, triggerUser, receiver] = await ethers.getSigners();

    await manager.setTaxConfig({
      buyTaxRate: 300,
      buyTaxToDividendPool: 3333,
      buyTaxToBuyback: 6667,
      sellTaxRate: 1200,
      sellTaxToDividendPool: 3000,
      sellTaxToEcosystem: 3000,
      sellTaxToBuyback: 4000,
    });

    await fundUserFromTreasury(token, seller.address, ethers.parseEther("200"));
    await fundUserFromTreasury(token, triggerUser.address, ethers.parseEther("5"));

    const deadBefore = await token.balanceOf("0x000000000000000000000000000000000000dEaD");
    const dividendBefore = await token.balanceOf(dividendPool.address);

    await token.connect(seller).approve(await router.getAddress(), ethers.parseEther("100"));
    await router.connect(seller).swapExactTokensForETH(
      ethers.parseEther("100"),
      0,
      [await token.getAddress(), await wbnb.getAddress()],
      seller.address,
      (await ethers.provider.getBlock("latest"))!.timestamp + 300
    );

    await token.connect(triggerUser).transfer(receiver.address, ethers.parseEther("1"));

    expect(await token.balanceOf(dividendPool.address)).to.equal(dividendBefore + ethers.parseEther("3"));
    expect(await token.balanceOf("0x000000000000000000000000000000000000dEaD")).to.equal(
      deadBefore + ethers.parseEther("90")
    );
  });
});