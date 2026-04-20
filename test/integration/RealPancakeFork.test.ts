import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import {
  deployFullSystemOnFork,
  PANCAKE_V2_FACTORY,
  PANCAKE_V2_ROUTER,
  WBNB_MAINNET,
} from "../helpers/deploy";
} from "../helpers/deploy.ts";
import { increaseTimeOneHour, increaseTimeOneMinute } from "../helpers/time.ts";

const { ethers } = hre;

const describeFork = process.env.BSC_RPC_URL ? describe : describe.skip;
const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD";

describeFork("USCAMEX Real Pancake Fork", function () {
  async function deployFixture() {
    return deployFullSystemOnFork();
  }

  async function fundUserFromTreasury(token: any, recipient: string, amount: bigint) {
    await token.rescueTokens(await token.getAddress(), amount);
    await token.transfer(recipient, amount);
  }

  it("deploys against real Pancake V2 router and factory on a BSC fork", async function () {
    const { token, router, factory, wbnb, pair } = await loadFixture(deployFixture);

    expect(await router.getAddress()).to.equal(PANCAKE_V2_ROUTER);
    expect(await factory.getAddress()).to.equal(PANCAKE_V2_FACTORY);
    expect(await wbnb.getAddress()).to.equal(WBNB_MAINNET);
    expect(await token.pair()).to.equal(await pair.getAddress());
    expect(
      await factory.getPair(await token.getAddress(), await wbnb.getAddress())
    ).to.equal(await pair.getAddress());
    expect(await pair.balanceOf(await token.getAddress())).to.be.gt(0);
    expect(await token.swapReceiver()).to.not.equal(ethers.ZeroAddress);
  });

  it("accepts a real fork deposit flow after routing bought tokens through an intermediate receiver", async function () {
    const { token, manager, rewardEngine } = await loadFixture(deployFixture);
    const [, , , , depositor] = await ethers.getSigners();

    await manager.setOperationMode(1);

    await depositor.sendTransaction({
      to: await token.getAddress(),
      value: ethers.parseEther("1"),
    });

    expect(await token.userLpShares(depositor.address)).to.be.gt(0);
    expect((await rewardEngine.getUserInfo(depositor.address)).depositAmount).to.equal(
      ethers.parseEther("1")
    );
    expect(await token.buybackReserve()).to.equal(ethers.parseEther("0.3"));
  });

  it("routes a real fork deposit across node payout, direct referral payout, dividend buy, and buyback reserve", async function () {
    const { token, manager, rewardEngine, dividendPool, owner } = await loadFixture(deployFixture);
    const [, , , , nodeHolder, parent, depositor] = await ethers.getSigners();

    await manager.setOperationMode(1);
    await manager.addNode(nodeHolder.address, ethers.parseEther("2"));

    await fundUserFromTreasury(token, parent.address, ethers.parseEther("20"));
    await token.connect(parent).transfer(owner.address, ethers.parseEther("10"));

    await fundUserFromTreasury(token, depositor.address, ethers.parseEther("20"));
    await token.connect(depositor).transfer(parent.address, ethers.parseEther("10"));

    const nodeBalanceBefore = await ethers.provider.getBalance(nodeHolder.address);
    const parentBalanceBefore = await ethers.provider.getBalance(parent.address);
    const dividendBefore = await token.balanceOf(dividendPool.address);

    await depositor.sendTransaction({
      to: await token.getAddress(),
      value: ethers.parseEther("1"),
    });

    expect(await ethers.provider.getBalance(nodeHolder.address)).to.equal(
      nodeBalanceBefore + ethers.parseEther("0.1")
    );
    expect(await ethers.provider.getBalance(parent.address)).to.equal(
      parentBalanceBefore + ethers.parseEther("0.1")
    );
    expect(await token.balanceOf(dividendPool.address)).to.be.gt(dividendBefore);
    expect(await token.buybackReserve()).to.equal(ethers.parseEther("0.1"));
    expect((await rewardEngine.getUserInfo(depositor.address)).depositAmount).to.equal(
      ethers.parseEther("1")
    );
  });

  it("propagates dynamic rewards on a real fork after a referred user settles static rewards", async function () {
    const { token, manager, rewardEngine, owner } = await loadFixture(deployFixture);
    const [, , , , parent, child] = await ethers.getSigners();

    await manager.setOperationMode(1);

    await fundUserFromTreasury(token, parent.address, ethers.parseEther("20"));
    await token.connect(parent).transfer(owner.address, ethers.parseEther("10"));

    await fundUserFromTreasury(token, child.address, ethers.parseEther("20"));
    await token.connect(child).transfer(parent.address, ethers.parseEther("10"));

    await parent.sendTransaction({
      to: await token.getAddress(),
      value: ethers.parseEther("1"),
    });

    await child.sendTransaction({
      to: await token.getAddress(),
      value: ethers.parseEther("1"),
    });

    await increaseTimeOneHour();
    await increaseTimeOneHour();
    await increaseTimeOneHour();
    await increaseTimeOneHour();
    await increaseTimeOneHour();
    await increaseTimeOneHour();

    const parentTokenBalanceBefore = await token.balanceOf(parent.address);

    await token.connect(child).claimRewards();

    const parentPending = await rewardEngine.getPendingRewards(parent.address);
    expect(parentPending[1]).to.equal(ethers.parseEther("0.0002"));

    await token.connect(parent).claimRewards();

    expect(await token.balanceOf(parent.address)).to.be.gt(parentTokenBalanceBefore);
  });

  it("blocks a real Pancake market buy when buy is disabled", async function () {
    const { token, router, wbnb } = await loadFixture(deployFixture);
    const [, , , , buyer] = await ethers.getSigners();

    await expect(
      router.connect(buyer).swapExactETHForTokens(
        0,
        [await wbnb.getAddress(), await token.getAddress()],
        buyer.address,
        (await ethers.provider.getBlock("latest"))!.timestamp + 300,
        { value: ethers.parseEther("1") }
      )
    ).to.be.revertedWith("Pancake: TRANSFER_FAILED");
  });

  it("processes sell tax correctly through the real Pancake supportingFeeOnTransfer path", async function () {
    const { token, router, wbnb, dividendPool, ecosystemFund } = await loadFixture(deployFixture);
    const [, , , , seller, triggerUser, receiver] = await ethers.getSigners();

    const sellAmount = ethers.parseEther("100");
    const ecosystemBefore = await ethers.provider.getBalance(ecosystemFund.address);
    const dividendBefore = await token.balanceOf(dividendPool.address);

    await fundUserFromTreasury(token, seller.address, ethers.parseEther("200"));
    await fundUserFromTreasury(token, triggerUser.address, ethers.parseEther("5"));

    await token.connect(seller).approve(await router.getAddress(), sellAmount);
    await router.connect(seller).swapExactTokensForETHSupportingFeeOnTransferTokens(
      sellAmount,
      0,
      [await token.getAddress(), await wbnb.getAddress()],
      seller.address,
      (await ethers.provider.getBlock("latest"))!.timestamp + 300
    );

    expect(await token.pendingEcosystemTaxTokens()).to.be.gt(0);
    expect(await token.pendingBuybackTaxTokens()).to.be.gt(0);
    expect(await token.pendingSellBurnTokens()).to.be.gt(0);
    expect(await token.balanceOf(dividendPool.address)).to.be.gt(dividendBefore);

    await token.connect(triggerUser).transfer(receiver.address, ethers.parseEther("1"));

    expect(await token.pendingEcosystemTaxTokens()).to.equal(0);
    expect(await token.pendingBuybackTaxTokens()).to.equal(0);
    expect(await token.pendingSellBurnTokens()).to.equal(0);
    expect(await ethers.provider.getBalance(ecosystemFund.address)).to.be.gt(ecosystemBefore);
    expect(await token.buybackReserve()).to.be.gt(0);
  });

  it("burns the token side when real Pancake LP is removed directly", async function () {
    const { token, router, pair, owner } = await loadFixture(deployFixture);

    const contractLpBalance = await pair.balanceOf(await token.getAddress());
    const withdrawalLpAmount = contractLpBalance / 10n;
    const ownerTokenBalanceBefore = await token.balanceOf(owner.address);
    const deadBefore = await token.balanceOf(DEAD_ADDRESS);

    await token.rescueTokens(await pair.getAddress(), withdrawalLpAmount);
    await pair.connect(owner).approve(await router.getAddress(), withdrawalLpAmount);

    await router.connect(owner).removeLiquidityETH(
      await token.getAddress(),
      withdrawalLpAmount,
      0,
      0,
      owner.address,
      (await ethers.provider.getBlock("latest"))!.timestamp + 300
    );

    expect(await token.balanceOf(owner.address)).to.equal(ownerTokenBalanceBefore);
    expect(await token.balanceOf(DEAD_ADDRESS)).to.be.gt(deadBefore);
  });

  it("accumulates taxes across sequential real Pancake buys and sells before a later interaction settles them", async function () {
    const { token, manager, router, wbnb, dividendPool, ecosystemFund } = await loadFixture(deployFixture);
    const [, , , , buyerOne, buyerTwo, triggerUser, receiver] = await ethers.getSigners();

    await manager.setBuyEnabled(true);
    await fundUserFromTreasury(token, triggerUser.address, ethers.parseEther("5"));

    const dividendBefore = await token.balanceOf(dividendPool.address);
    const ecosystemBefore = await ethers.provider.getBalance(ecosystemFund.address);

    await router.connect(buyerOne).swapExactETHForTokens(
      0,
      [await wbnb.getAddress(), await token.getAddress()],
      buyerOne.address,
      (await ethers.provider.getBlock("latest"))!.timestamp + 300,
      { value: ethers.parseEther("1") }
    );

    await router.connect(buyerTwo).swapExactETHForTokens(
      0,
      [await wbnb.getAddress(), await token.getAddress()],
      buyerTwo.address,
      (await ethers.provider.getBlock("latest"))!.timestamp + 300,
      { value: ethers.parseEther("1") }
    );

    const buyerOneBalance = await token.balanceOf(buyerOne.address);
    const sellAmount = buyerOneBalance / 2n;

    await token.connect(buyerOne).approve(await router.getAddress(), sellAmount);
    await router.connect(buyerOne).swapExactTokensForETHSupportingFeeOnTransferTokens(
      sellAmount,
      0,
      [await token.getAddress(), await wbnb.getAddress()],
      buyerOne.address,
      (await ethers.provider.getBlock("latest"))!.timestamp + 300
    );

    expect(await token.pendingBuybackTaxTokens()).to.be.gt(0);
    expect(await token.pendingEcosystemTaxTokens()).to.be.gt(0);
    expect(await token.pendingSellBurnTokens()).to.be.gt(0);

    await token.connect(triggerUser).transfer(receiver.address, ethers.parseEther("1"));

    expect(await token.pendingBuybackTaxTokens()).to.equal(0);
    expect(await token.pendingEcosystemTaxTokens()).to.equal(0);
    expect(await token.pendingSellBurnTokens()).to.equal(0);
    expect(await token.balanceOf(dividendPool.address)).to.be.gt(dividendBefore);
    expect(await ethers.provider.getBalance(ecosystemFund.address)).to.be.gt(ecosystemBefore);
    expect(await token.buybackReserve()).to.be.gt(0);
  });

  it("executes buyback once per minute and stops when the reserve becomes insufficient on a real fork", async function () {
    const { token, manager, router, wbnb } = await loadFixture(deployFixture);
    const [, , , , buyer, triggerUser, receiver] = await ethers.getSigners();

    await manager.setBuyEnabled(true);
    await fundUserFromTreasury(token, triggerUser.address, ethers.parseEther("5"));

    await router.connect(buyer).swapExactETHForTokens(
      0,
      [await wbnb.getAddress(), await token.getAddress()],
      buyer.address,
      (await ethers.provider.getBlock("latest"))!.timestamp + 300,
      { value: ethers.parseEther("1") }
    );

    await token.connect(triggerUser).transfer(receiver.address, ethers.parseEther("1"));

    const initialReserve = await token.buybackReserve();
    const perMinuteAmount = initialReserve / 2n + 1n;

    expect(initialReserve).to.be.gt(0);

    await manager.setBuybackConfig({
      active: true,
      perMinuteAmount,
    });

    const deadBefore = await token.balanceOf(DEAD_ADDRESS);

    await increaseTimeOneMinute();
    await token.connect(triggerUser).transfer(receiver.address, ethers.parseEther("1"));

    const deadAfterFirstBuyback = await token.balanceOf(DEAD_ADDRESS);
    expect(await token.buybackReserve()).to.equal(initialReserve - perMinuteAmount);
    expect(deadAfterFirstBuyback).to.be.gt(deadBefore);

    await increaseTimeOneMinute();
    await token.connect(triggerUser).transfer(receiver.address, ethers.parseEther("1"));

    expect(await token.buybackReserve()).to.equal(initialReserve - perMinuteAmount);
    expect(await token.balanceOf(DEAD_ADDRESS)).to.equal(deadAfterFirstBuyback);
  });

  it("executes real fork deflation by moving token inventory from the pair into the dividend pool", async function () {
    const { token, dividendPool, pair } = await loadFixture(deployFixture);

    const dividendBefore = await token.balanceOf(dividendPool.address);
    const pairBefore = await token.balanceOf(await pair.getAddress());

    await increaseTimeOneMinute();
    await increaseTimeOneHour();

    await token.executeDeflation();

    expect(await token.dailyDeflationAmount()).to.be.gt(0);
    expect(await token.balanceOf(dividendPool.address)).to.be.gt(dividendBefore);
    expect(await token.balanceOf(await pair.getAddress())).to.be.lt(pairBefore);
  });

  it("automatically closes the position on a real fork once exit is reached during reward claim", async function () {
    const { token, manager, rewardEngine } = await loadFixture(deployFixture);
    const [, , , , user] = await ethers.getSigners();

    await manager.setOperationMode(1);
    await manager.setRewardConfig({
      dailyStaticRate: 1000,
      exitMultiplier: 10,
    });

    await user.sendTransaction({
      to: await token.getAddress(),
      value: ethers.parseEther("1"),
    });

    const bnbBalanceBefore = await ethers.provider.getBalance(user.address);
    const lpSharesBefore = await token.userLpShares(user.address);

    expect(lpSharesBefore).to.be.gt(0);

    await increaseTimeOneHour();
    await increaseTimeOneHour();
    await increaseTimeOneHour();
    await increaseTimeOneHour();
    await increaseTimeOneHour();
    await increaseTimeOneHour();
    await increaseTimeOneHour();
    await increaseTimeOneHour();
    await increaseTimeOneHour();
    await increaseTimeOneHour();
    await increaseTimeOneHour();
    await increaseTimeOneHour();
    await increaseTimeOneHour();
    await increaseTimeOneHour();
    await increaseTimeOneHour();
    await increaseTimeOneHour();
    await increaseTimeOneHour();
    await increaseTimeOneHour();
    await increaseTimeOneHour();
    await increaseTimeOneHour();
    await increaseTimeOneHour();
    await increaseTimeOneHour();
    await increaseTimeOneHour();
    await increaseTimeOneHour();

    await token.connect(user).claimRewards();

    expect(await token.userLpShares(user.address)).to.equal(0);
    expect(await rewardEngine.hasExited(user.address)).to.equal(true);
    expect((await rewardEngine.getUserInfo(user.address)).depositAmount).to.equal(0);
    expect(await ethers.provider.getBalance(user.address)).to.be.gt(bnbBalanceBefore);
  });
});