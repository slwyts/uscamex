// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "./USCAMEXManager.sol";
import "./RewardEngine.sol";
import "./SwapReceiver.sol";
import "./libraries/SwapHelper.sol";
import "./interfaces/IPancakeRouter02.sol";
import "./interfaces/IPancakeFactory.sol";
import "./interfaces/IPancakePair.sol";

/**
 * @title USCAMEX
 * @dev Main ERC20 token contract with tax, LP deflation, buyback, and reward mechanisms
 */
contract USCAMEX is ERC20 {
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
    SwapReceiver public immutable swapReceiver;
    address public pair;

    // Tracking
    uint256 public lastDeflationTime;
    uint256 public dailyDeflationAmount;
    uint256 public lastDeflationDay;

    uint256 public lastBuybackTime;

    // K value tracking for buy/sell detection
    uint256 private lastK;
    uint8 private pendingRouterTransferKind;
    uint256 private pendingRouterTransferAmount;

    // Tax exemptions
    mapping(address => bool) public isTaxExempt;
    mapping(address => uint256) public userLpShares;
    bool private inSystemTransfer;
    bool private inAutomation;
    bool private inSystemRouterOperation;

    // Deferred tax accounting for manual backend processing.
    uint256 public pendingBuybackTaxTokens;
    uint256 public pendingEcosystemTaxTokens;
    uint256 public pendingSellBurnTokens;
    uint256 public buybackReserve;
    uint256 public distributedBindingTokens;

    // ========== EVENTS ==========

    event PairCreated(address indexed pair);
    event Deposited(address indexed user, uint256 bnbAmount);
    event Withdrawn(address indexed user, uint256 bnbAmount);
    event NodeRegistered(address indexed node, uint256 weight);
    event RewardsClaimed(address indexed user, uint256 tokenAmount);
    event DeflationExecuted(uint256 amount);
    event BuybackExecuted(uint256 bnbAmount, uint256 tokensBurned);
    event TaxRevenueProcessed(uint256 tokenAmount, uint256 ecosystemBNB, uint256 buybackBNB);
    event PendingSellBurnSettled(uint256 tokenAmount);
    event BindingTokensDistributed(address indexed to, uint256 amount);
    event ProjectLPWithdrawn(address indexed to, uint256 lpAmount);

    modifier onlyOwner() {
        require(msg.sender == owner(), "Not owner");
        _;
    }

    // ========== CONSTRUCTOR ==========

    constructor(
        address _manager,
        address _rewardEngine,
        address _router
    ) ERC20("USCAMEX", "USCAMEX") {
        require(_manager != address(0), "Invalid manager");
        require(_rewardEngine != address(0), "Invalid reward engine");
        require(_router != address(0), "Invalid router");

        manager = USCAMEXManager(_manager);
        rewardEngine = RewardEngine(_rewardEngine);
        router = IPancakeRouter02(_router);
        factory = IPancakeFactory(router.factory());
        WBNB = router.WETH();
        swapReceiver = new SwapReceiver(address(this));

        // Mint tokens
        _mint(address(this), TOTAL_SUPPLY);

        // Tax exempt addresses
        isTaxExempt[address(this)] = true;
        isTaxExempt[address(swapReceiver)] = true;
        isTaxExempt[owner()] = true;
        isTaxExempt[_manager] = true;
        isTaxExempt[_rewardEngine] = true;
        isTaxExempt[DEAD_ADDRESS] = true;

        lastDeflationTime = block.timestamp;
        lastBuybackTime = block.timestamp;
        lastDeflationDay = block.timestamp / 1 days;
    }

    function owner() public view returns (address) {
        return manager.owner();
    }

    function _sendBNB(address payable to, uint256 amount) internal {
        (bool success, ) = to.call{value: amount}("");
        require(success, "BNB transfer failed");
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
        if (msg.sender == address(router) || msg.sender == WBNB) {
            return;
        }

        USCAMEXManager.OperationMode mode = manager.operationMode();

        if (mode == USCAMEXManager.OperationMode.NODE_SALE) {
            _handleNodeSale();
        } else if (mode == USCAMEXManager.OperationMode.DEPOSIT) {
            _handleDeposit();
        } else {
            revert("Invalid operation mode");
        }

        _runAutomation();
    }

    // ========== NODE SALE ==========

    function _handleNodeSale() internal {
        require(msg.value > 0, "No BNB sent");

        // Register as node
        manager.registerNode(msg.sender, msg.value);

        emit NodeRegistered(msg.sender, msg.value);
    }

    // ========== DEPOSIT (ADD LP) ==========

    function _handleDeposit() internal {
        USCAMEXManager.DepositConfig memory config = manager.getDepositConfig();

        require(msg.value >= config.minDeposit && msg.value <= config.maxDeposit, "Invalid deposit amount");

        uint256 lpAmount = (msg.value * config.lpPercentage) / 10000;
        uint256 nodeAmount = (msg.value * config.nodePercentage) / 10000;
        uint256 dividendAmount = (msg.value * config.dividendPoolPercentage) / 10000;
        uint256 buybackAmount = (msg.value * config.buybackPercentage) / 10000;
        uint256 referralAmount = (msg.value * config.directReferralPercentage) / 10000;

        // 1. Build LP (60%)
        uint256 liquidity = _buildLP(lpAmount);
        if (liquidity > 0) {
            userLpShares[msg.sender] += liquidity;
        }

        // 2. Distribute to nodes (10%)
        _distributeToNodes(nodeAmount);

        // 3. Buy tokens for dividend pool (10%)
        _buyForDividendPool(dividendAmount);

        // 4. Send to buyback wallet (10%)
        buybackReserve += buybackAmount;

        // 5. Direct referral reward (10%)
        _handleDirectReferral(msg.sender, referralAmount);

        // Record deposit in reward engine
        rewardEngine.recordDeposit(msg.sender, msg.value);
        _syncNodeWeight(msg.sender);

        emit Deposited(msg.sender, msg.value);
    }

    function _buildLP(uint256 bnbAmount) internal returns (uint256 liquidity) {
        // Split BNB: half for LP, half to buy tokens
        uint256 halfBNB = bnbAmount / 2;
        uint256 otherHalf = bnbAmount - halfBNB;

        // Buy tokens with half BNB
        inSystemRouterOperation = true;
        uint256 tokensBought = SwapHelper.buyTokensWithExactBNB(
            address(router),
            address(this),
            halfBNB,
            0,
            address(swapReceiver)
        );
        inSystemRouterOperation = false;

        if (tokensBought > 0) {
            swapReceiver.forwardToken(address(this), address(this), tokensBought);
        }

        // Add liquidity
        _approve(address(this), address(router), tokensBought);
        (, , liquidity) = SwapHelper.addLiquidityBNB(
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
            buybackReserve += bnbAmount;
            return;
        }

        for (uint256 i = 0; i < nodes.length; i++) {
            uint256 nodeWeight = manager.nodeWeight(nodes[i]);
            uint256 share = (bnbAmount * nodeWeight) / totalWeight;
            if (share > 0) {
                _sendBNB(payable(nodes[i]), share);
            }
        }
    }

    function _buyForDividendPool(uint256 bnbAmount) internal {
        inSystemRouterOperation = true;
        uint256 tokensBought = SwapHelper.buyTokensWithExactBNB(
            address(router),
            address(this),
            bnbAmount,
            0,
            address(swapReceiver)
        );
        inSystemRouterOperation = false;

        if (tokensBought > 0) {
            swapReceiver.forwardToken(address(this), address(this), tokensBought);
            _systemTransfer(address(this), manager.dividendPool(), tokensBought);
        }
    }

    function _handleDirectReferral(address user, uint256 bnbAmount) internal {
        address referrer = rewardEngine.getReferrer(user);

        if (referrer == address(0) || referrer == address(this)) {
            buybackReserve += bnbAmount;
        } else {
            // Send to referrer
            _sendBNB(payable(referrer), bnbAmount);
        }
    }

    // ========== WITHDRAWAL ==========

    /**
     * @dev Withdraw LP - burns all tokens, returns only BNB
     */
    function withdrawLP(uint256 lpTokens) external {
        require(lpTokens == userLpShares[msg.sender], "Must withdraw full position");
        _withdrawPosition(msg.sender, lpTokens);
        _runAutomation();
    }

    function withdrawMyLP() external {
        _withdrawPosition(msg.sender, userLpShares[msg.sender]);
        _runAutomation();
    }

    function _withdrawPosition(address user, uint256 lpTokens) internal {
        require(lpTokens > 0, "Invalid amount");
        require(userLpShares[user] >= lpTokens, "Insufficient LP");

        _claimAndTransferRewards(user);
        userLpShares[user] -= lpTokens;

        // Approve router to consume the contract-held LP shares.
        IERC20(pair).approve(address(router), lpTokens);

        // Remove liquidity and burn the token side.
        (uint256 tokenAmount, uint256 bnbAmount) = router.removeLiquidityETH(
            address(this),
            lpTokens,
            0,
            0,
            address(this),
            block.timestamp + 300
        );

        _burn(address(this), tokenAmount);
        _sendBNB(payable(user), bnbAmount);

        rewardEngine.recordWithdrawal(user);
        _syncNodeWeight(user);

        emit Withdrawn(user, bnbAmount);
    }

    // ========== CLAIM REWARDS ==========

    function claimRewards() external {
        (uint256 staticRewards, uint256 dynamicRewards) = _claimAndTransferRewards(msg.sender);

        require(staticRewards + dynamicRewards > 0, "No rewards");

        if (rewardEngine.hasExited(msg.sender) && userLpShares[msg.sender] > 0) {
            _closeExitedPosition(msg.sender);
        }

        _runAutomation();
    }

    function processExitedPosition() external {
        require(rewardEngine.hasExited(msg.sender), "User not exited");
        require(userLpShares[msg.sender] > 0, "No LP position");

        _claimAndTransferRewards(msg.sender);
        _closeExitedPosition(msg.sender);
        _runAutomation();
    }

    function _claimAndTransferRewards(address user) internal returns (uint256 staticRewards, uint256 dynamicRewards) {
        (staticRewards, dynamicRewards) = rewardEngine.claim(user);

        uint256 totalBNBValue = staticRewards + dynamicRewards;
        if (totalBNBValue == 0) {
            return (0, 0);
        }

        // Convert BNB value to token amount
        uint256 tokenAmount = SwapHelper.getTokenEquivalent(
            address(factory),
            address(this),
            WBNB,
            totalBNBValue
        );
        require(tokenAmount > 0, "Reward price unavailable");
        require(balanceOf(manager.dividendPool()) >= tokenAmount, "Insufficient dividend pool");

        _systemTransfer(manager.dividendPool(), user, tokenAmount);

        emit RewardsClaimed(user, tokenAmount);
    }

    function _closeExitedPosition(address user) internal {
        uint256 lpTokens = userLpShares[user];
        if (lpTokens == 0) {
            rewardEngine.recordWithdrawal(user);
            return;
        }

        userLpShares[user] = 0;
        IERC20(pair).approve(address(router), lpTokens);

        (uint256 tokenAmount, uint256 bnbAmount) = router.removeLiquidityETH(
            address(this),
            lpTokens,
            0,
            0,
            address(this),
            block.timestamp + 300
        );

        _burn(address(this), tokenAmount);
        _sendBNB(payable(user), bnbAmount);
        rewardEngine.recordWithdrawal(user);
        _syncNodeWeight(user);

        emit Withdrawn(user, bnbAmount);
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

        if (from == address(0) || to == address(0) || pair == address(0)) {
            super._update(from, to, amount);
            return;
        }

        if (inSystemTransfer) {
            super._update(from, to, amount);
            return;
        }

        if (inSystemRouterOperation && (from == address(router) || to == address(router))) {
            super._update(from, to, amount);
            return;
        }

        if (from == pair && to == address(router)) {
            _stageRouterTransfer(amount);
            super._update(from, to, amount);
            return;
        }

        if (from == address(router) && to == pair && _isLiquidityAddPairInflow()) {
            super._update(from, to, amount);
            _updateKValue();
            return;
        }

        if (from == address(router) && pendingRouterTransferAmount > 0) {
            _settleRouterTransfer(from, to, amount);
            _updateKValue();
            return;
        }

        // Check for referral binding (exactly 10 tokens transfer)
        if (amount == BINDING_TRANSFER_AMOUNT && from != address(0) && to != address(0)) {
            if (!_isContract(to) && to != pair && from != pair) {
                // This is a referral binding transfer
                rewardEngine.bindReferral(from, to);
                super._update(from, to, amount);
                _runAutomation();
                return;
            }
        }

        // Tax exempt addresses
        if (isTaxExempt[from] || isTaxExempt[to] || from == owner() || to == owner()) {
            super._update(from, to, amount);
            return;
        }

        // Detect buy/sell
        bool isBuy = from == pair;
        bool isSell = to == pair;

        if (!isBuy && !isSell) {
            // Normal transfer, no tax
            super._update(from, to, amount);
            _runAutomation();
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

        USCAMEXManager.TaxConfig memory taxConfig = manager.getTaxConfig();

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
            pendingBuybackTaxTokens += toBuyback;
        }

        // Transfer after-tax amount to buyer
        super._update(from, to, afterTax);
    }

    function _handleSellTax(address from, address to, uint256 amount) internal {
        USCAMEXManager.TaxConfig memory taxConfig = manager.getTaxConfig();

        uint256 cappedTaxRate = taxConfig.sellTaxRate > 1000 ? 1000 : taxConfig.sellTaxRate;
        uint256 taxAmount = (amount * cappedTaxRate) / 10000;
        uint256 excessTax = taxConfig.sellTaxRate > 1000
            ? ((amount * (taxConfig.sellTaxRate - 1000)) / 10000)
            : 0;
        uint256 afterTax = amount - taxAmount - excessTax;

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
            pendingEcosystemTaxTokens += toEcosystem;
            pendingBuybackTaxTokens += toBuyback;
        }

        if (excessTax > 0) {
            super._update(from, DEAD_ADDRESS, excessTax);
        }

        // Transfer remaining amount to the pair so the AMM swap can complete.
        if (afterTax > 0) {
            super._update(from, to, afterTax);
            pendingSellBurnTokens += afterTax;
        }
    }

    // ========== DEFLATION ==========

    function executeDeflation() external {
        require(_executeDeflationInternal(), "Deflation not ready");
    }

    // ========== BUYBACK ==========

    function executeBuyback() external {
        require(_executeBuybackInternal(), "Buyback not ready");
    }

    function processTaxRevenue() external {
        require(_processPendingTaxRevenueInternal(), "No pending tax revenue");
        _executeBuybackInternal();
    }

    function settlePendingSellBurn(uint256 maxAmount) external {
        require(_settlePendingSellBurnInternal(maxAmount) > 0, "No pending sell burn");
    }

    function syncSystemState() external {
        _runAutomation();
    }

    function distributeBindingTokens(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "Invalid recipient");
        require(amount > 0, "Invalid amount");
        require(distributedBindingTokens + amount <= BINDING_AMOUNT, "Exceeds binding allocation");
        require(balanceOf(address(this)) >= amount, "Insufficient token balance");

        distributedBindingTokens += amount;
        _systemTransfer(address(this), to, amount);

        emit BindingTokensDistributed(to, amount);
    }

    function remainingBindingTokens() external view returns (uint256) {
        return BINDING_AMOUNT - distributedBindingTokens;
    }

    function withdrawBuybackReserve(address payable to, uint256 amount) external onlyOwner {
        require(to != address(0), "Invalid recipient");
        require(amount <= buybackReserve, "Amount exceeds reserve");
        buybackReserve -= amount;
        _sendBNB(to, amount);
    }

    function withdrawProjectLP(address to, uint256 amount) external onlyOwner {
        require(pair != address(0), "Pair not created");
        require(to != address(0), "Invalid recipient");
        require(amount > 0, "Invalid amount");

        uint256 lpBalance = IERC20(pair).balanceOf(address(this));
        require(amount <= lpBalance, "Amount exceeds LP balance");

        IERC20(pair).transfer(to, amount);

        emit ProjectLPWithdrawn(to, amount);
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

    function _systemTransfer(address from, address to, uint256 amount) internal {
        inSystemTransfer = true;
        super._update(from, to, amount);
        inSystemTransfer = false;
    }

    function _stageRouterTransfer(uint256 amount) internal {
        pendingRouterTransferAmount = amount;
        pendingRouterTransferKind = _isBuyPairOutflow() ? 1 : 2;
    }

    function _settleRouterTransfer(address from, address to, uint256 amount) internal {
        uint8 transferKind = pendingRouterTransferKind;
        uint256 transferAmount = pendingRouterTransferAmount;

        pendingRouterTransferKind = 0;
        pendingRouterTransferAmount = 0;

        if (transferKind == 1) {
            _handleBuyTax(from, to, transferAmount);
            return;
        }

        if (transferKind == 2) {
            if (to == address(this)) {
                super._update(from, to, transferAmount);
            } else {
                super._update(from, DEAD_ADDRESS, transferAmount);
            }
            _runAutomation();
            return;
        }

        super._update(from, to, amount);
    }

    function _isBuyPairOutflow() internal view returns (bool) {
        if (pair == address(0)) {
            return false;
        }

        (uint112 reserve0, uint112 reserve1, ) = IPancakePair(pair).getReserves();
        address token0 = IPancakePair(pair).token0();

        uint256 reserveBNB = token0 == WBNB ? uint256(reserve0) : uint256(reserve1);
        uint256 currentBNBBalance = IERC20(WBNB).balanceOf(pair);

        return currentBNBBalance > reserveBNB;
    }

    function _isLiquidityAddPairInflow() internal view returns (bool) {
        if (pair == address(0)) {
            return false;
        }

        (uint112 reserve0, uint112 reserve1, ) = IPancakePair(pair).getReserves();
        address token0 = IPancakePair(pair).token0();

        uint256 reserveBNB = token0 == WBNB ? uint256(reserve0) : uint256(reserve1);
        uint256 currentBNBBalance = IERC20(WBNB).balanceOf(pair);

        return currentBNBBalance > reserveBNB;
    }

    function _syncNodeWeight(address user) internal {
        (uint256 depositAmount, , , , ) = rewardEngine.getUserInfo(user);

        if (depositAmount == 0) {
            if (manager.isNode(user)) {
                manager.removeNodeByToken(user);
            }
            return;
        }

        manager.setNodeWeightByToken(user, depositAmount);
    }

    function _runAutomation() internal {
        if (inAutomation || inSystemTransfer || pair == address(0)) {
            return;
        }

        inAutomation = true;

        _processPendingTaxRevenueInternal();
        _settlePendingSellBurnInternal(0);
        _executeDeflationInternal();
        _executeBuybackInternal();

        inAutomation = false;
    }

    function _processPendingTaxRevenueInternal() internal returns (bool processed) {
        uint256 buybackTokens = pendingBuybackTaxTokens;
        uint256 ecosystemTokens = pendingEcosystemTaxTokens;
        uint256 totalTokens = buybackTokens + ecosystemTokens;

        if (totalTokens == 0) {
            return false;
        }

        pendingBuybackTaxTokens = 0;
        pendingEcosystemTaxTokens = 0;

        _approve(address(this), address(router), totalTokens);
        inSystemRouterOperation = true;
        uint256 bnbReceived = SwapHelper.sellTokensForExactBNB(
            address(router),
            address(this),
            totalTokens,
            0,
            address(this)
        );
        inSystemRouterOperation = false;

        uint256 ecosystemBNB = 0;
        if (ecosystemTokens > 0) {
            ecosystemBNB = (bnbReceived * ecosystemTokens) / totalTokens;
            if (ecosystemBNB > 0) {
                _sendBNB(payable(manager.ecosystemFund()), ecosystemBNB);
            }
        }

        uint256 buybackBNB = bnbReceived - ecosystemBNB;
        if (buybackBNB > 0) {
            buybackReserve += buybackBNB;
        }

        emit TaxRevenueProcessed(totalTokens, ecosystemBNB, buybackBNB);
        return true;
    }

    function _settlePendingSellBurnInternal(uint256 maxAmount) internal returns (uint256 burnAmount) {
        if (pendingSellBurnTokens == 0 || pair == address(0)) {
            return 0;
        }

        burnAmount = maxAmount == 0 || maxAmount > pendingSellBurnTokens
            ? pendingSellBurnTokens
            : maxAmount;

        uint256 availablePairBalance = balanceOf(pair);
        if (availablePairBalance == 0) {
            return 0;
        }

        if (burnAmount > availablePairBalance) {
            burnAmount = availablePairBalance;
        }

        pendingSellBurnTokens -= burnAmount;
        _systemTransfer(pair, DEAD_ADDRESS, burnAmount);
        IPancakePair(pair).sync();

        emit PendingSellBurnSettled(burnAmount);
        return burnAmount;
    }

    function _executeDeflationInternal() internal returns (bool executed) {
        USCAMEXManager.DeflationConfig memory config = manager.getDeflationConfig();

        if (!config.enabled || block.timestamp < lastDeflationTime + 1 hours) {
            return false;
        }

        uint256 currentDay = block.timestamp / 1 days;
        if (currentDay > lastDeflationDay) {
            dailyDeflationAmount = 0;
            lastDeflationDay = currentDay;
        }

        (uint256 tokenReserve, ) = SwapHelper.getReserves(address(factory), address(this), WBNB);
        if (tokenReserve == 0) {
            return false;
        }

        uint256 deflationAmount = (tokenReserve * config.hourlyRate) / 10000;
        uint256 dailyCapAmount = (tokenReserve * config.dailyCap) / 10000;

        if (deflationAmount == 0 || dailyDeflationAmount + deflationAmount > dailyCapAmount) {
            return false;
        }

        _systemTransfer(pair, manager.dividendPool(), deflationAmount);
        IPancakePair(pair).sync();

        dailyDeflationAmount += deflationAmount;
        lastDeflationTime = block.timestamp;

        emit DeflationExecuted(deflationAmount);
        return true;
    }

    function _executeBuybackInternal() internal returns (bool executed) {
        USCAMEXManager.BuybackConfig memory config = manager.getBuybackConfig();

        if (!config.active || block.timestamp < lastBuybackTime + 1 minutes) {
            return false;
        }

        if (buybackReserve < config.perMinuteAmount) {
            return false;
        }

        buybackReserve -= config.perMinuteAmount;
        inSystemRouterOperation = true;
        uint256 tokensBurned = SwapHelper.buyTokensWithExactBNB(
            address(router),
            address(this),
            config.perMinuteAmount,
            0,
            DEAD_ADDRESS
        );
        inSystemRouterOperation = false;

        lastBuybackTime = block.timestamp;

        emit BuybackExecuted(config.perMinuteAmount, tokensBurned);
        return true;
    }

    // ========== ADMIN FUNCTIONS ==========

    function setTaxExempt(address account, bool exempt) external onlyOwner {
        isTaxExempt[account] = exempt;
    }

    function rescueTokens(address token, uint256 amount) external onlyOwner {
        IERC20(token).transfer(owner(), amount);
    }

    function rescueBNB(uint256 amount) external onlyOwner {
        _sendBNB(payable(owner()), amount);
    }
}
