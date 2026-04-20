import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { deployFullSystem } from "../helpers/deploy";

const { ethers } = hre;

describe("USCAMEX Token", function () {
  async function deployFixture() {
    return await deployFullSystem();
  }

  async function fundUserFromTreasury(token: any, recipient: string, amount: bigint) {
    await token.rescueTokens(await token.getAddress(), amount);
    await token.transfer(recipient, amount);
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

    it("Should use manager ownership as the single owner source", async function () {
      const { token, manager, rewardEngine } = await loadFixture(deployFixture);
      const [, newOwner] = await ethers.getSigners();

      const TreasuryVault = await ethers.getContractFactory("TreasuryVault");
      const vault = await TreasuryVault.deploy(await manager.getAddress());
      await vault.waitForDeployment();

      expect(await token.owner()).to.equal(await manager.owner());
      expect(await rewardEngine.owner()).to.equal(await manager.owner());
      expect(await vault.owner()).to.equal(await manager.owner());

      await manager.transferOwnership(newOwner.address);

      expect(await token.owner()).to.equal(newOwner.address);
      expect(await rewardEngine.owner()).to.equal(newOwner.address);
      expect(await vault.owner()).to.equal(newOwner.address);
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
      const { token } = await loadFixture(deployFixture);
      const [, , , , user1, user2] = await ethers.getSigners();

      const amount = ethers.parseEther("100");

      await fundUserFromTreasury(token, user1.address, amount);

      // Transfer between users (not buy/sell)
      await token.connect(user1).transfer(user2.address, amount);

      expect(await token.balanceOf(user2.address)).to.equal(amount);
    });
  });

  describe("Referral Binding", function () {
    it("Should bind referral on exact 10 token transfer", async function () {
      const { token, owner, rewardEngine } = await loadFixture(deployFixture);
      const [, , , , , user2] = await ethers.getSigners();

      const bindingAmount = ethers.parseEther("10");

      await fundUserFromTreasury(token, user2.address, bindingAmount * 2n);

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

      await fundUserFromTreasury(token, user1.address, amount);

      // User1 sends 15 tokens (not 10)
      await token.connect(user1).transfer(owner.address, amount);

      // Should not be bound
      expect(await rewardEngine.getReferrer(user1.address)).to.equal(
        ethers.ZeroAddress
      );
    });

    it("Should distribute binding tokens within the reserved 1 percent allocation", async function () {
      const { token } = await loadFixture(deployFixture);
      const [, , , , user1] = await ethers.getSigners();

      const amount = ethers.parseEther("1000");
      await token.distributeBindingTokens(user1.address, amount);

      expect(await token.balanceOf(user1.address)).to.equal(amount);
      expect(await token.distributedBindingTokens()).to.equal(amount);
      expect(await token.remainingBindingTokens()).to.equal(await token.BINDING_AMOUNT() - amount);
    });

    it("Should revert when binding token distribution exceeds the reserved allocation", async function () {
      const { token } = await loadFixture(deployFixture);
      const [, , , , user1] = await ethers.getSigners();

      await expect(
        token.distributeBindingTokens(user1.address, (await token.BINDING_AMOUNT()) + 1n)
      ).to.be.revertedWith("Exceeds binding allocation");
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

    it("Should automatically sync node status and weight with deposits", async function () {
      const { token, manager } = await loadFixture(deployFixture);
      const [, , , , user1] = await ethers.getSigners();

      await manager.setOperationMode(1);

      await user1.sendTransaction({
        to: await token.getAddress(),
        value: ethers.parseEther("1"),
      });

      expect(await manager.isNode(user1.address)).to.equal(true);
      expect(await manager.nodeWeight(user1.address)).to.equal(ethers.parseEther("1"));

      await user1.sendTransaction({
        to: await token.getAddress(),
        value: ethers.parseEther("0.5"),
      });

      expect(await manager.nodeWeight(user1.address)).to.equal(ethers.parseEther("1.5"));
    });

    it("Should remove node status after full LP withdrawal", async function () {
      const { token, manager } = await loadFixture(deployFixture);
      const [, , , , user1] = await ethers.getSigners();

      await manager.setOperationMode(1);

      await user1.sendTransaction({
        to: await token.getAddress(),
        value: ethers.parseEther("1"),
      });

      expect(await manager.isNode(user1.address)).to.equal(true);

      await token.connect(user1).withdrawMyLP();

      expect(await manager.isNode(user1.address)).to.equal(false);
      expect(await manager.nodeWeight(user1.address)).to.equal(0);
    });
  });

  describe("Direct Pancake Interactions", function () {
    it("Should block direct market buy when buy is disabled", async function () {
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
      ).to.be.revertedWith("Buy not enabled");
    });

    it("Should allow direct liquidity add without treating it as a sell", async function () {
      const { token, router, pair } = await loadFixture(deployFixture);
      const [, , , , lpProvider] = await ethers.getSigners();

      const tokenAmount = ethers.parseEther("1000");
      await fundUserFromTreasury(token, lpProvider.address, tokenAmount);
      await token.connect(lpProvider).approve(await router.getAddress(), tokenAmount);

      await router.connect(lpProvider).addLiquidityETH(
        await token.getAddress(),
        tokenAmount,
        0,
        0,
        lpProvider.address,
        (await ethers.provider.getBlock("latest"))!.timestamp + 300,
        { value: ethers.parseEther("1") }
      );

      expect(await pair.balanceOf(lpProvider.address)).to.be.gt(0);
      expect(await token.pendingSellBurnTokens()).to.equal(0);
      expect(await token.pendingEcosystemTaxTokens()).to.equal(0);
      expect(await token.pendingBuybackTaxTokens()).to.equal(0);
    });

    it("Should burn token side when user removes Pancake LP directly", async function () {
      const { token, router, pair } = await loadFixture(deployFixture);
      const [, , , , lpProvider] = await ethers.getSigners();

      const tokenAmount = ethers.parseEther("1000");
      await fundUserFromTreasury(token, lpProvider.address, tokenAmount);
      await token.connect(lpProvider).approve(await router.getAddress(), tokenAmount);

      await router.connect(lpProvider).addLiquidityETH(
        await token.getAddress(),
        tokenAmount,
        0,
        0,
        lpProvider.address,
        (await ethers.provider.getBlock("latest"))!.timestamp + 300,
        { value: ethers.parseEther("1") }
      );

      const lpBalance = await pair.balanceOf(lpProvider.address);
      const tokenBalanceBefore = await token.balanceOf(lpProvider.address);
      const deadBefore = await token.balanceOf("0x000000000000000000000000000000000000dEaD");

      await pair.connect(lpProvider).approve(await router.getAddress(), lpBalance);
      await router.connect(lpProvider).removeLiquidityETH(
        await token.getAddress(),
        lpBalance,
        0,
        0,
        lpProvider.address,
        (await ethers.provider.getBlock("latest"))!.timestamp + 300,
      );

      expect(await token.balanceOf(lpProvider.address)).to.equal(tokenBalanceBefore);
      expect(await token.balanceOf("0x000000000000000000000000000000000000dEaD")).to.be.gt(deadBefore);
    });
  });

  describe("Admin Functions", function () {
    it("Should allow owner to rescue tokens", async function () {
      const { token, owner } = await loadFixture(deployFixture);

      const amount = ethers.parseEther("100");
      const ownerBalanceBefore = await token.balanceOf(owner.address);

      await token.rescueTokens(await token.getAddress(), amount);

      expect(await token.balanceOf(owner.address)).to.equal(ownerBalanceBefore + amount);
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
