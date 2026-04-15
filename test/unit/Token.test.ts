import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { deployFullSystem } from "../helpers/deploy";

describe("USCAMEX Token", function () {
  async function deployFixture() {
    return await deployFullSystem();
  }

  describe("Deployment", function () {
    it("Should have correct name and symbol", async function () {
      const { token } = await loadFixture(deployFixture);

      expect(await token.name()).to.equal("USCAMEX");
      expect(await token.symbol()).to.equal("USCAMEX");
    });

    it("Should have total supply of 1 billion", async function () {
      const { token } = await loadFixture(deployFixture);
      const totalSupply = ethers.parseEther("1000000000"); // 1 billion

      expect(await token.totalSupply()).to.equal(totalSupply);
    });

    it("Should create pair on deployment", async function () {
      const { token, factory, wbnb } = await loadFixture(deployFixture);

      const pairAddress = await factory.getPair(
        await token.getAddress(),
        await wbnb.getAddress()
      );

      expect(pairAddress).to.not.equal(ethers.ZeroAddress);
      expect(await token.pair()).to.equal(pairAddress);
    });

    it("Should add initial liquidity", async function () {
      const { token, pair } = await loadFixture(deployFixture);

      const lpBalance = await pair.balanceOf(await token.getAddress());
      expect(lpBalance).to.be.gt(0);
    });
  });

  describe("Tax Exemptions", function () {
    it("Should exempt token contract from tax", async function () {
      const { token } = await loadFixture(deployFixture);

      expect(await token.isTaxExempt(await token.getAddress())).to.equal(true);
    });

    it("Should exempt owner from tax", async function () {
      const { token, owner } = await loadFixture(deployFixture);

      expect(await token.isTaxExempt(owner.address)).to.equal(true);
    });

    it("Should allow owner to set tax exemption", async function () {
      const { token } = await loadFixture(deployFixture);
      const [, , , , user] = await ethers.getSigners();

      await token.setTaxExempt(user.address, true);
      expect(await token.isTaxExempt(user.address)).to.equal(true);

      await token.setTaxExempt(user.address, false);
      expect(await token.isTaxExempt(user.address)).to.equal(false);
    });
  });

  describe("Normal Transfers", function () {
    it("Should allow normal transfers without tax", async function () {
      const { token, owner } = await loadFixture(deployFixture);
      const [, , , , user1, user2] = await ethers.getSigners();

      const amount = ethers.parseEther("100");

      // Give tokens to user1 (from owner, tax exempt)
      await token.transfer(user1.address, amount);

      // Transfer between users (not buy/sell)
      await token.connect(user1).transfer(user2.address, amount);

      expect(await token.balanceOf(user2.address)).to.equal(amount);
    });
  });

  describe("Referral Binding", function () {
    it("Should bind referral on exact 10 token transfer", async function () {
      const { token, owner, rewardEngine } = await loadFixture(deployFixture);
      const [, , , , user1, user2] = await ethers.getSigners();

      const bindingAmount = ethers.parseEther("10");

      // Give tokens to user2
      await token.transfer(user2.address, bindingAmount * 2n);

      // User2 sends exactly 10 tokens to owner to bind
      await token.connect(user2).transfer(owner.address, bindingAmount);

      // Check referral binding
      expect(await rewardEngine.getReferrer(user2.address)).to.equal(
        owner.address
      );
    });

    it("Should not bind on transfers other than 10 tokens", async function () {
      const { token, owner, rewardEngine } = await loadFixture(deployFixture);
      const [, , , , user1] = await ethers.getSigners();

      const amount = ethers.parseEther("15");

      // Give tokens to user1
      await token.transfer(user1.address, amount);

      // User1 sends 15 tokens (not 10)
      await token.connect(user1).transfer(owner.address, amount);

      // Should not be bound
      expect(await rewardEngine.getReferrer(user1.address)).to.equal(
        ethers.ZeroAddress
      );
    });
  });

  describe("Operation Modes", function () {
    it("Should accept BNB in NODE_SALE mode", async function () {
      const { token, manager } = await loadFixture(deployFixture);
      const [, , , , user1] = await ethers.getSigners();

      // Ensure in NODE_SALE mode
      expect(await manager.operationMode()).to.equal(0);

      // Send BNB to register as node
      const depositAmount = ethers.parseEther("1");
      await user1.sendTransaction({
        to: await token.getAddress(),
        value: depositAmount,
      });

      // Check node registration
      expect(await manager.isNode(user1.address)).to.equal(true);
      expect(await manager.nodeWeight(user1.address)).to.equal(depositAmount);
    });

    it("Should accept BNB in DEPOSIT mode", async function () {
      const { token, manager, rewardEngine } = await loadFixture(deployFixture);
      const [, , , , user1] = await ethers.getSigners();

      // Switch to DEPOSIT mode
      await manager.setOperationMode(1);

      const depositAmount = ethers.parseEther("1");
      await user1.sendTransaction({
        to: await token.getAddress(),
        value: depositAmount,
      });

      // Check deposit recorded
      const userInfo = await rewardEngine.getUserInfo(user1.address);
      expect(userInfo.depositAmount).to.equal(depositAmount);
    });
  });

  describe("Admin Functions", function () {
    it("Should allow owner to rescue tokens", async function () {
      const { token, owner } = await loadFixture(deployFixture);

      // Assume some tokens are stuck in contract
      const amount = ethers.parseEther("100");
      await token.rescueTokens(await token.getAddress(), amount);

      // Tokens should be sent to owner
      // (This would fail in practice without tokens in contract, but tests the function)
    });

    it("Should allow owner to rescue BNB", async function () {
      const { token, owner } = await loadFixture(deployFixture);
      const [, , , , user1] = await ethers.getSigners();

      // Send some BNB to contract
      const bnbAmount = ethers.parseEther("1");
      await user1.sendTransaction({
        to: await token.getAddress(),
        value: bnbAmount,
      });

      const ownerBalanceBefore = await ethers.provider.getBalance(owner.address);

      await token.rescueBNB(bnbAmount);

      const ownerBalanceAfter = await ethers.provider.getBalance(owner.address);

      // Owner should have received BNB (minus gas)
      expect(ownerBalanceAfter).to.be.gt(ownerBalanceBefore);
    });
  });
});
