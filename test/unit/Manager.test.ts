import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { deployFullSystem } from "../helpers/deploy";

describe("USCAMEXManager", function () {
  async function deployFixture() {
    return await deployFullSystem();
  }

  describe("Deployment", function () {
    it("Should set the correct owner", async function () {
      const { manager, owner } = await loadFixture(deployFixture);
      expect(await manager.owner()).to.equal(owner.address);
    });

    it("Should initialize with correct wallet addresses", async function () {
      const { manager, dividendPool, ecosystemFund, buybackWallet } =
        await loadFixture(deployFixture);

      expect(await manager.dividendPool()).to.equal(dividendPool.address);
      expect(await manager.ecosystemFund()).to.equal(ecosystemFund.address);
      expect(await manager.buybackWallet()).to.equal(buybackWallet.address);
    });

    it("Should initialize with default tax config", async function () {
      const { manager } = await loadFixture(deployFixture);
      const taxConfig = await manager.taxConfig();

      expect(taxConfig.buyTaxRate).to.equal(300); // 3%
      expect(taxConfig.sellTaxRate).to.equal(1000); // 10%
    });

    it("Should initialize with default deposit config", async function () {
      const { manager } = await loadFixture(deployFixture);
      const depositConfig = await manager.depositConfig();

      expect(depositConfig.minDeposit).to.equal(ethers.parseEther("0.1"));
      expect(depositConfig.maxDeposit).to.equal(ethers.parseEther("5"));
      expect(depositConfig.lpPercentage).to.equal(6000); // 60%
    });

    it("Should initialize in NODE_SALE mode", async function () {
      const { manager } = await loadFixture(deployFixture);
      expect(await manager.operationMode()).to.equal(0); // NODE_SALE = 0
    });

    it("Should initialize with buy disabled", async function () {
      const { manager } = await loadFixture(deployFixture);
      expect(await manager.buyEnabled()).to.equal(false);
    });
  });

  describe("Operation Mode", function () {
    it("Should allow owner to change operation mode", async function () {
      const { manager, owner } = await loadFixture(deployFixture);

      await manager.setOperationMode(1); // DEPOSIT mode
      expect(await manager.operationMode()).to.equal(1);
    });

    it("Should emit OperationModeChanged event", async function () {
      const { manager } = await loadFixture(deployFixture);

      await expect(manager.setOperationMode(1))
        .to.emit(manager, "OperationModeChanged")
        .withArgs(1);
    });

    it("Should revert when non-owner tries to change mode", async function () {
      const { manager } = await loadFixture(deployFixture);
      const [, , , , user] = await ethers.getSigners();

      await expect(
        manager.connect(user).setOperationMode(1)
      ).to.be.revertedWithCustomError(manager, "OwnableUnauthorizedAccount");
    });
  });

  describe("Tax Configuration", function () {
    it("Should allow owner to update tax config", async function () {
      const { manager } = await loadFixture(deployFixture);

      const newConfig = {
        buyTaxRate: 500, // 5%
        buyTaxToDividendPool: 5000, // 50%
        buyTaxToBuyback: 5000, // 50%
        sellTaxRate: 1200, // 12%
        sellTaxToDividendPool: 4000, // 40%
        sellTaxToEcosystem: 3000, // 30%
        sellTaxToBuyback: 3000, // 30%
      };

      await manager.setTaxConfig(newConfig);
      const taxConfig = await manager.taxConfig();

      expect(taxConfig.buyTaxRate).to.equal(500);
      expect(taxConfig.sellTaxRate).to.equal(1200);
    });

    it("Should revert if buy tax split doesn't equal 100%", async function () {
      const { manager } = await loadFixture(deployFixture);

      const invalidConfig = {
        buyTaxRate: 300,
        buyTaxToDividendPool: 6000, // 60%
        buyTaxToBuyback: 5000, // 50% - total 110%!
        sellTaxRate: 1000,
        sellTaxToDividendPool: 3000,
        sellTaxToEcosystem: 3000,
        sellTaxToBuyback: 4000,
      };

      await expect(manager.setTaxConfig(invalidConfig)).to.be.revertedWith(
        "Buy tax split must equal 100%"
      );
    });

    it("Should revert if sell tax split doesn't equal 100%", async function () {
      const { manager } = await loadFixture(deployFixture);

      const invalidConfig = {
        buyTaxRate: 300,
        buyTaxToDividendPool: 5000,
        buyTaxToBuyback: 5000,
        sellTaxRate: 1000,
        sellTaxToDividendPool: 4000, // 40%
        sellTaxToEcosystem: 4000, // 40%
        sellTaxToBuyback: 3000, // 30% - total 110%!
      };

      await expect(manager.setTaxConfig(invalidConfig)).to.be.revertedWith(
        "Sell tax split must equal 100%"
      );
    });
  });

  describe("Node Management", function () {
    it("Should allow owner to add nodes", async function () {
      const { manager } = await loadFixture(deployFixture);
      const [, , , , node1] = await ethers.getSigners();

      await manager.addNode(node1.address, ethers.parseEther("1"));

      expect(await manager.isNode(node1.address)).to.equal(true);
      expect(await manager.nodeWeight(node1.address)).to.equal(
        ethers.parseEther("1")
      );
    });

    it("Should emit NodeAdded event", async function () {
      const { manager } = await loadFixture(deployFixture);
      const [, , , , node1] = await ethers.getSigners();

      await expect(manager.addNode(node1.address, ethers.parseEther("1")))
        .to.emit(manager, "NodeAdded")
        .withArgs(node1.address, ethers.parseEther("1"));
    });

    it("Should allow owner to remove nodes", async function () {
      const { manager } = await loadFixture(deployFixture);
      const [, , , , node1] = await ethers.getSigners();

      await manager.addNode(node1.address, ethers.parseEther("1"));
      await manager.removeNode(node1.address);

      expect(await manager.isNode(node1.address)).to.equal(false);
      expect(await manager.nodeWeight(node1.address)).to.equal(0);
    });

    it("Should calculate total node weight correctly", async function () {
      const { manager } = await loadFixture(deployFixture);
      const [, , , , node1, node2, node3] = await ethers.getSigners();

      await manager.addNode(node1.address, ethers.parseEther("1"));
      await manager.addNode(node2.address, ethers.parseEther("2"));
      await manager.addNode(node3.address, ethers.parseEther("3"));

      expect(await manager.getTotalNodeWeight()).to.equal(
        ethers.parseEther("6")
      );
    });
  });

  describe("Team Reward Rates", function () {
    it("Should return correct team reward rates for all generations", async function () {
      const { manager } = await loadFixture(deployFixture);

      const expectedRates = [1000, 900, 800, 700, 600, 500, 500, 500, 500, 500];

      for (let i = 1; i <= 10; i++) {
        expect(await manager.getTeamRewardRate(i)).to.equal(expectedRates[i - 1]);
      }
    });

    it("Should revert for invalid generation (0)", async function () {
      const { manager } = await loadFixture(deployFixture);

      await expect(manager.getTeamRewardRate(0)).to.be.revertedWith(
        "Invalid generation"
      );
    });

    it("Should revert for invalid generation (11)", async function () {
      const { manager } = await loadFixture(deployFixture);

      await expect(manager.getTeamRewardRate(11)).to.be.revertedWith(
        "Invalid generation"
      );
    });
  });

  describe("Buy Enable/Disable", function () {
    it("Should allow owner to enable buy", async function () {
      const { manager } = await loadFixture(deployFixture);

      await manager.setBuyEnabled(true);
      expect(await manager.buyEnabled()).to.equal(true);
    });

    it("Should emit BuyEnabledChanged event", async function () {
      const { manager } = await loadFixture(deployFixture);

      await expect(manager.setBuyEnabled(true))
        .to.emit(manager, "BuyEnabledChanged")
        .withArgs(true);
    });
  });
});
