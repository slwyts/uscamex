// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./USCAMEXManager.sol";
import "./RewardEngine.sol";
import "./libraries/SwapHelper.sol";
import "./interfaces/IPancakeRouter02.sol";
import "./interfaces/IPancakeFactory.sol";
import "./interfaces/IPancakePair.sol";

/**
 * @title USCAMEX
 * @dev Main ERC20 token contract with tax, LP deflation, buyback, and reward mechanisms
 */
contract USCAMEX is ERC20, Ownable {
    using SwapHelper for address;

    // ========== CONSTANTS ==========

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 * 1e18; // 1 billion
    uint256 public constant BINDING_AMOUNT = 10_000_000 * 1e18; // 1% for binding (10 million)
    uint256 public constant LP_AMOUNT = 990_000_000 * 1e18; // 99% for LP (990 million)
    uint256 public constant BINDING_TRANSFER_AMOUNT = 10 * 1e18; // Exact 10 tokens to bind referral
    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    // ========== STATE VARIABLES ==========

    USCAMEXManager public immutable manager;
    RewardEngine public immutable rewardEngine;

    IPancakeRouter02 public immutable router;
    IPancakeFactory public immutable factory;
    address public immutable WBNB;
    address public pair;

    // Tracking
    uint256 public lastDeflationTime;
    uint256 public dailyDeflationAmount;
    uint256 public lastDeflationDay;

    uint256 public lastBuybackTime;

    // K value tracking for buy/sell detection
    uint256 private lastK;

    // Tax exemptions
    mapping(address => bool) public isTaxExempt;

    // ========== EVENTS ==========

    event PairCreated(address indexed pair);
    event Deposited(address indexed user, uint256 bnbAmount);
    event Withdrawn(address indexed user, uint256 bnbAmount);
    event NodeRegistered(address indexed node, uint256 weight);
    event RewardsClaimed(address indexed user, uint256 tokenAmount);
    event DeflationExecuted(uint256 amount);
    event BuybackExecuted(uint256 bnbAmount, uint256 tokensBurned);

    // ========== CONSTRUCTOR ==========

    constructor(
        address _manager,
        address _rewardEngine,
        address _router
    ) ERC20("USCAMEX", "USCAMEX") Ownable(msg.sender) {
        require(_manager != address(0), "Invalid manager");
        require(_rewardEngine != address(0), "Invalid reward engine");
        require(_router != address(0), "Invalid router");

        manager = USCAMEXManager(_manager);
        rewardEngine = RewardEngine(_rewardEngine);
        router = IPancakeRouter02(_router);
        factory = IPancakeFactory(router.factory());
        WBNB = router.WETH();

        // Mint tokens
        _mint(address(this), TOTAL_SUPPLY);

        // Tax exempt addresses
        isTaxExempt[address(this)] = true;
        isTaxExempt[owner()] = true;
        isTaxExempt[_manager] = true;
        isTaxExempt[_rewardEngine] = true;
        isTaxExempt[DEAD_ADDRESS] = true;

        lastDeflationTime = block.timestamp;
        lastBuybackTime = block.timestamp;
        lastDeflationDay = block.timestamp / 1 days;
    }

    // ========== SETUP ==========

    /**
     * @dev Create PancakeSwap pair and add initial liquidity
     * Must be called after deployment
     */
    function createPairAndAddLiquidity() external payable onlyOwner {
        require(pair == address(0), "Pair already created");
        require(msg.value > 0, "Need BNB for LP");

        // Create pair
        pair = factory.createPair(address(this), WBNB);
        isTaxExempt[pair] = true;
        emit PairCreated(pair);

        // Approve router
        _approve(address(this), address(router), LP_AMOUNT);

        // Add liquidity
        router.addLiquidityETH{value: msg.value}(
            address(this),
            LP_AMOUNT,
            0,
            0,
            address(this), // LP tokens stay in contract
            block.timestamp + 300
        );

        // Initialize K value
        _updateKValue();
    }

    // ========== RECEIVE FUNCTION ==========

    /**
     * @dev Receive BNB - route based on operation mode
     */
    receive() external payable {
        USCAMEXManager.OperationMode mode = manager.operationMode();

        if (mode == USCAMEXManager.OperationMode.NODE_SALE) {
            _handleNodeSale();
        } else if (mode == USCAMEXManager.OperationMode.DEPOSIT) {
            _handleDeposit();
        } else {
            revert("Invalid operation mode");
        }
    }

    // ========== NODE SALE ==========

    function _handleNodeSale() internal {
        require(msg.value > 0, "No BNB sent");

        // Register as node
        manager.addNode(msg.sender, msg.value);

        emit NodeRegistered(msg.sender, msg.value);
    }

    // ========== DEPOSIT (ADD LP) ==========

    function _handleDeposit() internal {
        USCAMEXManager.DepositConfig memory config = manager.depositConfig();

        require(msg.value >= config.minDeposit && msg.value <= config.maxDeposit, "Invalid deposit amount");

        uint256 lpAmount = (msg.value * config.lpPercentage) / 10000;
        uint256 nodeAmount = (msg.value * config.nodePercentage) / 10000;
        uint256 dividendAmount = (msg.value * config.dividendPoolPercentage) / 10000;
        uint256 buybackAmount = (msg.value * config.buybackPercentage) / 10000;
        uint256 referralAmount = (msg.value * config.directReferralPercentage) / 10000;

        // 1. Build LP (60%)
        _buildLP(lpAmount);

        // 2. Distribute to nodes (10%)
        _distributeToNodes(nodeAmount);

        // 3. Buy tokens for dividend pool (10%)
        _buyForDividendPool(dividendAmount);

        // 4. Send to buyback wallet (10%)
        payable(manager.buybackWallet()).transfer(buybackAmount);

        // 5. Direct referral reward (10%)
        _handleDirectReferral(msg.sender, referralAmount);

        // Record deposit in reward engine
        rewardEngine.recordDeposit(msg.sender, msg.value);

        emit Deposited(msg.sender, msg.value);
    }

    function _buildLP(uint256 bnbAmount) internal {
        // Split BNB: half for LP, half to buy tokens
        uint256 halfBNB = bnbAmount / 2;
        uint256 otherHalf = bnbAmount - halfBNB;

        // Buy tokens with half BNB
        uint256 tokensBought = SwapHelper.buyTokensWithExactBNB(
            address(router),
            address(this),
            halfBNB,
            0,
            address(this)
        );

        // Add liquidity
        _approve(address(this), address(router), tokensBought);
        SwapHelper.addLiquidityBNB(
            address(router),
            address(this),
            tokensBought,
            otherHalf,
            0,
            0,
            address(this)
        );
    }

    function _distributeToNodes(uint256 bnbAmount) internal {
        address[] memory nodes = manager.getNodeAddresses();
        uint256 totalWeight = manager.getTotalNodeWeight();

        if (nodes.length == 0 || totalWeight == 0) {
            // No nodes, send to buyback
            payable(manager.buybackWallet()).transfer(bnbAmount);
            return;
        }

        for (uint256 i = 0; i < nodes.length; i++) {
            uint256 nodeWeight = manager.nodeWeight(nodes[i]);
            uint256 share = (bnbAmount * nodeWeight) / totalWeight;
            if (share > 0) {
                payable(nodes[i]).transfer(share);
            }
        }
    }

    function _buyForDividendPool(uint256 bnbAmount) internal {
        SwapHelper.buyTokensWithExactBNB(
            address(router),
            address(this),
            bnbAmount,
            0,
            manager.dividendPool()
        );
    }

    function _handleDirectReferral(address user, uint256 bnbAmount) internal {
        address referrer = rewardEngine.getReferrer(user);

        if (referrer == address(0) || referrer == address(this)) {
            // No referrer, send to buyback
            payable(manager.buybackWallet()).transfer(bnbAmount);
        } else {
            // Send to referrer
            payable(referrer).transfer(bnbAmount);
        }
    }

    // ========== WITHDRAWAL ==========

    /**
     * @dev Withdraw LP - burns all tokens, returns only BNB
     */
    function withdrawLP(uint256 lpTokens) external {
        require(lpTokens > 0, "Invalid amount");
        require(IERC20(pair).balanceOf(msg.sender) >= lpTokens, "Insufficient LP");

        // Transfer LP tokens to this contract
        IERC20(pair).transferFrom(msg.sender, address(this), lpTokens);

        // Approve router
        IERC20(pair).approve(address(router), lpTokens);

        // Remove liquidity
        (uint256 tokenAmount, uint256 bnbAmount) = router.removeLiquidityETH(
            address(this),
            lpTokens,
            0,
            0,
            address(this),
            block.timestamp + 300
        );

        // Burn tokens
        _burn(address(this), tokenAmount);

        // Return only BNB
        payable(msg.sender).transfer(bnbAmount);

        // Record withdrawal
        rewardEngine.recordWithdrawal(msg.sender);

        emit Withdrawn(msg.sender, bnbAmount);
    }

    // ========== CLAIM REWARDS ==========

    function claimRewards() external {
        (uint256 staticRewards, uint256 dynamicRewards) = rewardEngine.claim(msg.sender);

        uint256 totalBNBValue = staticRewards + dynamicRewards;
        require(totalBNBValue > 0, "No rewards");

        // Convert BNB value to token amount
        uint256 tokenAmount = SwapHelper.getTokenEquivalent(
            address(factory),
            address(this),
            WBNB,
            totalBNBValue
        );

        // Transfer tokens from dividend pool
        IERC20(address(this)).transferFrom(manager.dividendPool(), msg.sender, tokenAmount);

        emit RewardsClaimed(msg.sender, tokenAmount);
    }

    // ========== CORE TRANSFER LOGIC ==========

    /**
     * @dev Override _update to implement all tax and interception logic
     */
    function _update(address from, address to, uint256 amount) internal override {
        if (amount == 0) {
            super._update(from, to, 0);
            return;
        }

        // Check for referral binding (exactly 10 tokens transfer)
        if (amount == BINDING_TRANSFER_AMOUNT && from != address(0) && to != address(0)) {
            if (!_isContract(to) && to != pair && from != pair) {
                // This is a referral binding transfer
                rewardEngine.bindReferral(from, to);
                super._update(from, to, amount);
                return;
            }
        }

        // Tax exempt addresses
        if (isTaxExempt[from] || isTaxExempt[to]) {
            super._update(from, to, amount);
            return;
        }

        // Detect buy/sell
        bool isBuy = from == pair;
        bool isSell = to == pair;

        if (!isBuy && !isSell) {
            // Normal transfer, no tax
            super._update(from, to, amount);
            return;
        }

        if (isBuy) {
            _handleBuyTax(from, to, amount);
        } else if (isSell) {
            _handleSellTax(from, to, amount);
        }

        _updateKValue();
    }

    function _handleBuyTax(address from, address to, uint256 amount) internal {
        require(manager.buyEnabled(), "Buy not enabled");

        USCAMEXManager.TaxConfig memory taxConfig = manager.taxConfig();

        // Calculate tax
        uint256 taxAmount = (amount * taxConfig.buyTaxRate) / 10000;
        uint256 afterTax = amount - taxAmount;

        // Split tax
        uint256 toDividendPool = (taxAmount * taxConfig.buyTaxToDividendPool) / 10000;
        uint256 toBuyback = taxAmount - toDividendPool;

        // Transfer tokens to dividend pool
        if (toDividendPool > 0) {
            super._update(from, manager.dividendPool(), toDividendPool);
        }

        // For buyback portion, we need BNB, so sell tokens
        if (toBuyback > 0) {
            super._update(from, address(this), toBuyback);
            // Note: In practice, we'd swap these tokens for BNB and send to buyback wallet
            // For simplicity in this implementation, we'll keep tokens in contract
        }

        // Transfer after-tax amount to buyer
        super._update(from, to, afterTax);
    }

    function _handleSellTax(address from, address to, uint256 amount) internal {
        USCAMEXManager.TaxConfig memory taxConfig = manager.taxConfig();

        // Calculate tax
        uint256 taxAmount = (amount * taxConfig.sellTaxRate) / 10000;
        uint256 afterTax = amount - taxAmount;

        // Split tax
        uint256 toDividendPool = (taxAmount * taxConfig.sellTaxToDividendPool) / 10000;
        uint256 toEcosystem = (taxAmount * taxConfig.sellTaxToEcosystem) / 10000;
        uint256 toBuyback = (taxAmount * taxConfig.sellTaxToBuyback) / 10000;

        // Tokens to dividend pool
        if (toDividendPool > 0) {
            super._update(from, manager.dividendPool(), toDividendPool);
        }

        // For ecosystem and buyback, we need BNB
        uint256 tokensForBNB = toEcosystem + toBuyback;
        if (tokensForBNB > 0) {
            super._update(from, address(this), tokensForBNB);
        }

        // If sell tax > 10%, excess goes to dead
        if (taxConfig.sellTaxRate > 1000) {
            uint256 excessTax = ((taxConfig.sellTaxRate - 1000) * amount) / 10000;
            if (excessTax > 0) {
                super._update(from, DEAD_ADDRESS, excessTax);
            }
        }

        // Burn remaining tokens after tax (per requirements)
        if (afterTax > 0) {
            super._update(from, DEAD_ADDRESS, afterTax);
        }

        // Note: Actual BNB would come from the swap, simplified here
        super._update(from, to, amount);
    }

    // ========== DEFLATION ==========

    function executeDeflation() external {
        USCAMEXManager.DeflationConfig memory config = manager.deflationConfig();

        require(config.enabled, "Deflation not enabled");
        require(block.timestamp >= lastDeflationTime + 1 hours, "Too soon");

        // Check daily cap
        uint256 currentDay = block.timestamp / 1 days;
        if (currentDay > lastDeflationDay) {
            dailyDeflationAmount = 0;
            lastDeflationDay = currentDay;
        }

        (uint256 tokenReserve, ) = SwapHelper.getReserves(address(factory), address(this), WBNB);

        uint256 deflationAmount = (tokenReserve * config.hourlyRate) / 10000;
        uint256 dailyCapAmount = (tokenReserve * config.dailyCap) / 10000;

        // Check if we've hit daily cap
        require(dailyDeflationAmount + deflationAmount <= dailyCapAmount, "Daily cap reached");

        // Remove tokens from pair to dividend pool
        IERC20(address(this)).transferFrom(pair, manager.dividendPool(), deflationAmount);

        // Sync pair
        IPancakePair(pair).sync();

        dailyDeflationAmount += deflationAmount;
        lastDeflationTime = block.timestamp;

        emit DeflationExecuted(deflationAmount);
    }

    // ========== BUYBACK ==========

    function executeBuyback() external {
        USCAMEXManager.BuybackConfig memory config = manager.buybackConfig();

        require(config.active, "Buyback not active");
        require(block.timestamp >= lastBuybackTime + 1 minutes, "Too soon");

        uint256 buybackBalance = address(manager.buybackWallet()).balance;
        require(buybackBalance >= config.perMinuteAmount, "Insufficient buyback balance");

        // Note: In practice, we'd call buyback wallet to execute swap
        // This is simplified - actual implementation would need buyback wallet cooperation

        lastBuybackTime = block.timestamp;

        emit BuybackExecuted(config.perMinuteAmount, 0);
    }

    // ========== HELPERS ==========

    function _updateKValue() internal {
        if (pair == address(0)) return;

        (uint256 reserve0, uint256 reserve1, ) = IPancakePair(pair).getReserves();
        lastK = reserve0 * reserve1;
    }

    function _isContract(address account) internal view returns (bool) {
        uint256 size;
        assembly {
            size := extcodesize(account)
        }
        return size > 0;
    }

    // ========== ADMIN FUNCTIONS ==========

    function setTaxExempt(address account, bool exempt) external onlyOwner {
        isTaxExempt[account] = exempt;
    }

    function rescueTokens(address token, uint256 amount) external onlyOwner {
        IERC20(token).transfer(owner(), amount);
    }

    function rescueBNB(uint256 amount) external onlyOwner {
        payable(owner()).transfer(amount);
    }
}
