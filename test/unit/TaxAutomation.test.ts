import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { deployFullSystem, deployWithConfig } from "../helpers/deploy.ts";
import { increaseTimeOneMinute } from "../helpers/time.ts";

const { ethers } = hre;

describe("USCAMEX Tax Automation", function () {
  async function deployFixture() {
    return await deployFullSystem();
  }

  async function buybackFixture() {
    const deployment = await deployWithConfig(undefined, undefined, undefined, {
      active: true,
      perMinuteAmount: ethers.parseEther("0.05"),
    });

    await deployment.manager.setOperationMode(1);
    return deployment;
  }

  async function fundUserFromTreasury(token: any, recipient: string, amount: bigint) {
    await token.rescueTokens(await token.getAddress(), amount);
    await token.transfer(recipient, amount);
  }

  it("settles buy tax automatically on the next user interaction", async function () {
    const { token, manager, router, wbnb, dividendPool } = await loadFixture(deployFixture);
    const [, , , , buyer, receiver] = await ethers.getSigners();

    await manager.setBuyEnabled(true);

    await router.connect(buyer).swapExactETHForTokens(
      0,
      [await wbnb.getAddress(), await token.getAddress()],
      buyer.address,
      (await ethers.provider.getBlock("latest"))!.timestamp + 300,
      { value: ethers.parseEther("1") }
    );

    expect(await token.pendingBuybackTaxTokens()).to.be.gt(0);
    expect(await token.balanceOf(dividendPool.address)).to.be.gt(0);

    await token.connect(buyer).transfer(receiver.address, ethers.parseEther("1"));

    expect(await token.pendingBuybackTaxTokens()).to.equal(0);
    expect(await token.buybackReserve()).to.be.gt(0);
  });

  it("settles sell tax and burns pending sell inventory automatically", async function () {
    const { token, router, wbnb, dividendPool, ecosystemFund } = await loadFixture(deployFixture);
    const [, , , , seller, triggerUser, receiver] = await ethers.getSigners();

    const sellAmount = ethers.parseEther("100");
    const transferAmount = ethers.parseEther("1");
    const ecosystemBefore = await ethers.provider.getBalance(ecosystemFund.address);
    const dividendBefore = await token.balanceOf(dividendPool.address);

    await fundUserFromTreasury(token, seller.address, ethers.parseEther("200"));
    await fundUserFromTreasury(token, triggerUser.address, ethers.parseEther("5"));

    await token.connect(seller).approve(await router.getAddress(), sellAmount);
    await router.connect(seller).swapExactTokensForETH(
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

    await token.connect(triggerUser).transfer(receiver.address, transferAmount);

    expect(await token.pendingEcosystemTaxTokens()).to.equal(0);
    expect(await token.pendingBuybackTaxTokens()).to.equal(0);
    expect(await token.pendingSellBurnTokens()).to.equal(0);
    expect(await ethers.provider.getBalance(ecosystemFund.address)).to.be.gt(ecosystemBefore);
    expect(await token.buybackReserve()).to.be.gt(0);
  });

  it("runs buyback automatically after activation when a later interaction occurs", async function () {
    const { token } = await loadFixture(buybackFixture);
    const [, , , , depositor, triggerUser, receiver] = await ethers.getSigners();

    await depositor.sendTransaction({
      to: await token.getAddress(),
      value: ethers.parseEther("1"),
    });

    const deadBefore = await token.balanceOf("0x000000000000000000000000000000000000dEaD");
    expect(await token.buybackReserve()).to.equal(ethers.parseEther("0.3"));

    await increaseTimeOneMinute();
    await fundUserFromTreasury(token, triggerUser.address, ethers.parseEther("5"));
    await token.connect(triggerUser).transfer(receiver.address, ethers.parseEther("1"));

    expect(await token.buybackReserve()).to.equal(ethers.parseEther("0.25"));
    expect(await token.balanceOf("0x000000000000000000000000000000000000dEaD")).to.be.gt(deadBefore);
  });
});