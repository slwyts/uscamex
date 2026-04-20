// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title USCAMEXManager
 * @dev External management contract for all USCAMEX parameters
 */
contract USCAMEXManager is Ownable {
    // ========== STRUCTS ==========

    struct TaxConfig {
        uint256 buyTaxRate; // Total buy tax rate (basis points, e.g., 300 = 3%)
        uint256 buyTaxToDividendPool; // Percentage of buy tax to dividend pool (basis points)
        uint256 buyTaxToBuyback; // Percentage of buy tax to buyback (basis points)
        uint256 sellTaxRate; // Total sell tax rate (basis points, e.g., 1000 = 10%)
        uint256 sellTaxToDividendPool; // Percentage of sell tax to dividend pool
        uint256 sellTaxToEcosystem; // Percentage of sell tax to ecosystem
        uint256 sellTaxToBuyback; // Percentage of sell tax to buyback
    }

    struct DepositConfig {
        uint256 minDeposit; // Min BNB deposit (wei)
        uint256 maxDeposit; // Max BNB deposit (wei)
        uint256 lpPercentage; // Percentage to LP (basis points, default 6000 = 60%)
        uint256 nodePercentage; // Percentage to nodes (basis points, default 1000 = 10%)
        uint256 dividendPoolPercentage; // Percentage to dividend pool (basis points, default 1000 = 10%)
        uint256 buybackPercentage; // Percentage to buyback (basis points, default 1000 = 10%)
        uint256 directReferralPercentage; // Percentage to direct referral (basis points, default 1000 = 10%)
    }

    struct DeflationConfig {
        bool enabled; // Deflation enabled
        uint256 hourlyRate; // Hourly deflation rate (basis points, default 10 = 0.1%)
        uint256 dailyCap; // Daily deflation cap (basis points, default 200 = 2%)
    }

    struct BuybackConfig {
        bool active; // Buyback active
        uint256 perMinuteAmount; // BNB amount per minute (wei, default 0.1 BNB)
    }

    struct RewardConfig {
        uint256 dailyStaticRate; // Daily static rate (basis points, default 80 = 0.8%)
        uint256 exitMultiplier; // Exit multiplier (e.g., 300 = 3x)
    }

    // ========== STATE VARIABLES ==========

    // Operation mode
    enum OperationMode { NODE_SALE, DEPOSIT }
    OperationMode public operationMode;

    // Tax configuration
    TaxConfig public taxConfig;

    // Deposit configuration
    DepositConfig public depositConfig;

    // Deflation configuration
    DeflationConfig public deflationConfig;

    // Buyback configuration
    BuybackConfig public buybackConfig;

    // Reward configuration
    RewardConfig public rewardConfig;

    // Core wallets
    address public dividendPool;
    address public ecosystemFund;
    address public buybackWallet;

    // Authorized token contract
    address public tokenContract;

    // Buy switch
    bool public buyEnabled;

    // Nodes
    address[] public nodeAddresses;
    mapping(address => bool) public isNode;
    mapping(address => uint256) public nodeWeight; // Weight = deposit amount

    // Team reward tiers (fixed percentages, cannot be modified)
    uint256[10] public teamRewardRates = [1000, 900, 800, 700, 600, 500, 500, 500, 500, 500]; // 10%, 9%, 8%, 7%, 6%, 5%, 5%, 5%, 5%, 5%

    // ========== EVENTS ==========

    event OperationModeChanged(OperationMode newMode);
    event TaxConfigUpdated(TaxConfig config);
    event DepositConfigUpdated(DepositConfig config);
    event DeflationConfigUpdated(DeflationConfig config);
    event BuybackConfigUpdated(BuybackConfig config);
    event RewardConfigUpdated(RewardConfig config);
    event WalletUpdated(string walletType, address newWallet);
    event BuyEnabledChanged(bool enabled);
    event TokenContractSet(address indexed tokenContract);
    event NodeAdded(address indexed node, uint256 weight);
    event NodeRemoved(address indexed node);
    event NodeWeightUpdated(address indexed node, uint256 newWeight);

    // ========== MODIFIERS ==========

    modifier onlyToken() {
        require(msg.sender == tokenContract, "Not token contract");
        _;
    }

    // ========== CONSTRUCTOR ==========

    constructor(
        address initialOwner,
        address _dividendPool,
        address _ecosystemFund,
        address _buybackWallet
    ) Ownable(initialOwner) {
        require(initialOwner != address(0), "Invalid owner");
        require(_dividendPool != address(0), "Invalid dividend pool");
        require(_ecosystemFund != address(0), "Invalid ecosystem fund");
        require(_buybackWallet != address(0), "Invalid buyback wallet");

        dividendPool = _dividendPool;
        ecosystemFund = _ecosystemFund;
        buybackWallet = _buybackWallet;

        // Default tax config
        taxConfig = TaxConfig({
            buyTaxRate: 300, // 3%
            buyTaxToDividendPool: 3333, // 1/3 of tax
            buyTaxToBuyback: 6667, // 2/3 of tax
            sellTaxRate: 1000, // 10%
            sellTaxToDividendPool: 3000, // 30% of tax
            sellTaxToEcosystem: 3000, // 30% of tax
            sellTaxToBuyback: 4000 // 40% of tax
        });

        // Default deposit config
        depositConfig = DepositConfig({
            minDeposit: 0.1 ether,
            maxDeposit: 5 ether,
            lpPercentage: 6000, // 60%
            nodePercentage: 1000, // 10%
            dividendPoolPercentage: 1000, // 10%
            buybackPercentage: 1000, // 10%
            directReferralPercentage: 1000 // 10%
        });

        // Default deflation config
        deflationConfig = DeflationConfig({
            enabled: true,
            hourlyRate: 10, // 0.1%
            dailyCap: 200 // 2%
        });

        // Default buyback config
        buybackConfig = BuybackConfig({
            active: false,
            perMinuteAmount: 0.1 ether
        });

        // Default reward config
        rewardConfig = RewardConfig({
            dailyStaticRate: 80, // 0.8%
            exitMultiplier: 300 // 3x
        });

        operationMode = OperationMode.NODE_SALE;
        buyEnabled = false;
    }

    // ========== VIEW FUNCTIONS ==========

    function getTeamRewardRate(uint256 generation) external view returns (uint256) {
        require(generation > 0 && generation <= 10, "Invalid generation");
        return teamRewardRates[generation - 1];
    }

    function getTaxConfig() external view returns (TaxConfig memory) {
        return taxConfig;
    }

    function getDepositConfig() external view returns (DepositConfig memory) {
        return depositConfig;
    }

    function getDeflationConfig() external view returns (DeflationConfig memory) {
        return deflationConfig;
    }

    function getBuybackConfig() external view returns (BuybackConfig memory) {
        return buybackConfig;
    }

    function getRewardConfig() external view returns (RewardConfig memory) {
        return rewardConfig;
    }

    function getTotalNodes() external view returns (uint256) {
        return nodeAddresses.length;
    }

    function getNodeAddresses() external view returns (address[] memory) {
        return nodeAddresses;
    }

    function getTotalNodeWeight() external view returns (uint256) {
        uint256 total = 0;
        for (uint256 i = 0; i < nodeAddresses.length; i++) {
            total += nodeWeight[nodeAddresses[i]];
        }
        return total;
    }

    // ========== ADMIN FUNCTIONS ==========

    function setOperationMode(OperationMode _mode) external onlyOwner {
        operationMode = _mode;
        emit OperationModeChanged(_mode);
    }

    function setTokenContract(address _tokenContract) external onlyOwner {
        require(_tokenContract != address(0), "Invalid token contract");
        tokenContract = _tokenContract;
        emit TokenContractSet(_tokenContract);
    }

    function setTaxConfig(TaxConfig calldata _config) external onlyOwner {
        require(_config.buyTaxRate <= 10000, "Buy tax too high");
        require(_config.sellTaxRate <= 10000, "Sell tax too high");
        require(
            _config.buyTaxToDividendPool + _config.buyTaxToBuyback == 10000,
            "Buy tax split must equal 100%"
        );
        require(
            _config.sellTaxToDividendPool + _config.sellTaxToEcosystem + _config.sellTaxToBuyback == 10000,
            "Sell tax split must equal 100%"
        );
        taxConfig = _config;
        emit TaxConfigUpdated(_config);
    }

    function setDepositConfig(DepositConfig calldata _config) external onlyOwner {
        require(_config.minDeposit > 0, "Min deposit must be > 0");
        require(_config.maxDeposit >= _config.minDeposit, "Max must be >= min");
        require(
            _config.lpPercentage + _config.nodePercentage + _config.dividendPoolPercentage +
            _config.buybackPercentage + _config.directReferralPercentage == 10000,
            "Percentages must equal 100%"
        );
        depositConfig = _config;
        emit DepositConfigUpdated(_config);
    }

    function setDeflationConfig(DeflationConfig calldata _config) external onlyOwner {
        require(_config.hourlyRate <= 1000, "Hourly rate too high"); // Max 10%
        require(_config.dailyCap <= 10000, "Daily cap too high"); // Max 100%
        deflationConfig = _config;
        emit DeflationConfigUpdated(_config);
    }

    function setBuybackConfig(BuybackConfig calldata _config) external onlyOwner {
        buybackConfig = _config;
        emit BuybackConfigUpdated(_config);
    }

    function setRewardConfig(RewardConfig calldata _config) external onlyOwner {
        require(_config.dailyStaticRate <= 1000, "Static rate too high"); // Max 10%
        require(_config.exitMultiplier > 0, "Exit multiplier must be > 0");
        rewardConfig = _config;
        emit RewardConfigUpdated(_config);
    }

    function setDividendPool(address _pool) external onlyOwner {
        require(_pool != address(0), "Invalid address");
        dividendPool = _pool;
        emit WalletUpdated("dividendPool", _pool);
    }

    function setEcosystemFund(address _fund) external onlyOwner {
        require(_fund != address(0), "Invalid address");
        ecosystemFund = _fund;
        emit WalletUpdated("ecosystemFund", _fund);
    }

    function setBuybackWallet(address _wallet) external onlyOwner {
        require(_wallet != address(0), "Invalid address");
        buybackWallet = _wallet;
        emit WalletUpdated("buybackWallet", _wallet);
    }

    function setBuyEnabled(bool _enabled) external onlyOwner {
        buyEnabled = _enabled;
        emit BuyEnabledChanged(_enabled);
    }

    function addNode(address _node, uint256 _weight) external onlyOwner {
        _addNode(_node, _weight);
    }

    function registerNode(address _node, uint256 _weight) external onlyToken {
        _addNode(_node, _weight);
    }

    function _addNode(address _node, uint256 _weight) internal {
        require(_node != address(0), "Invalid node");
        require(!isNode[_node], "Already a node");
        nodeAddresses.push(_node);
        isNode[_node] = true;
        nodeWeight[_node] = _weight;
        emit NodeAdded(_node, _weight);
    }

    function removeNode(address _node) external onlyOwner {
        _removeNode(_node);
    }

    function removeNodeByToken(address _node) external onlyToken {
        _removeNode(_node);
    }

    function setNodeWeightByToken(address _node, uint256 _weight) external onlyToken {
        if (_weight == 0) {
            if (isNode[_node]) {
                _removeNode(_node);
            }
            return;
        }

        if (!isNode[_node]) {
            _addNode(_node, _weight);
            return;
        }

        nodeWeight[_node] = _weight;
        emit NodeWeightUpdated(_node, _weight);
    }

    function _removeNode(address _node) internal {
        require(isNode[_node], "Not a node");
        isNode[_node] = false;
        nodeWeight[_node] = 0;

        // Remove from array
        for (uint256 i = 0; i < nodeAddresses.length; i++) {
            if (nodeAddresses[i] == _node) {
                nodeAddresses[i] = nodeAddresses[nodeAddresses.length - 1];
                nodeAddresses.pop();
                break;
            }
        }

        emit NodeRemoved(_node);
    }

    function updateNodeWeight(address _node, uint256 _weight) external onlyOwner {
        require(isNode[_node], "Not a node");
        nodeWeight[_node] = _weight;
        emit NodeWeightUpdated(_node, _weight);
    }
}
