// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./USCAMEXManager.sol";
import "./libraries/ReferralTree.sol";

/**
 * @title RewardEngine
 * @dev Independent reward calculation and distribution contract
 */
contract RewardEngine {
    using ReferralTree for ReferralTree.Tree;

    // ========== STRUCTS ==========

    struct UserInfo {
        uint256 depositAmount; // BNB deposit amount (金本位基准)
        uint256 totalStaticRewards; // Total static rewards earned (BNB value)
        uint256 totalDynamicRewards; // Total dynamic rewards earned (BNB value)
        uint256 lastSettleTime; // Last settlement timestamp
        bool exited; // Whether user has exited
    }

    // ========== STATE VARIABLES ==========

    USCAMEXManager public manager;
    ReferralTree.Tree private referralTree;

    mapping(address => UserInfo) public users;

    uint256 public constant SETTLEMENT_INTERVAL = 6 hours;
    uint256 public constant BASIS_POINTS = 10000;

    address public immutable owner;
    address public tokenContract; // Will be set by token contract

    // ========== EVENTS ==========

    event Deposited(address indexed user, uint256 bnbAmount);
    event RewardsSettled(address indexed user, uint256 staticRewards, uint256 dynamicRewards);
    event Exited(address indexed user, uint256 totalRewards);
    event ReferralBound(address indexed user, address indexed referrer);

    // ========== MODIFIERS ==========

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier onlyToken() {
        require(msg.sender == tokenContract, "Not token contract");
        _;
    }

    // ========== CONSTRUCTOR ==========

    constructor(address _manager) {
        require(_manager != address(0), "Invalid manager");
        manager = USCAMEXManager(_manager);
        owner = msg.sender;

        // Owner is the root of referral tree
        // No need to explicitly set, as owner won't have a referrer
    }

    // ========== SETUP ==========

    function setTokenContract(address _token) external onlyOwner {
        require(tokenContract == address(0), "Token already set");
        require(_token != address(0), "Invalid token");
        tokenContract = _token;
    }

    // ========== REFERRAL FUNCTIONS ==========

    function bindReferral(address user, address referrer) external onlyToken {
        require(user != address(0), "Invalid user");
        require(referrer != address(0), "Invalid referrer");
        require(user != referrer, "Cannot refer self");
        require(!referralTree.hasReferrer(user), "Already bound");

        // Check that referrer has a referrer (unless referrer is owner/root)
        if (referrer != owner) {
            require(
                referralTree.hasReferrer(referrer),
                "Referrer must be in tree"
            );
        }

        referralTree.bind(user, referrer);
        emit ReferralBound(user, referrer);
    }

    function getReferrer(address user) external view returns (address) {
        return referralTree.getReferrer(user);
    }

    function getDirectReferralCount(address user) external view returns (uint256) {
        return referralTree.getDirectReferralCount(user);
    }

    function getAncestors(address user, uint256 depth) external view returns (address[] memory) {
        return referralTree.getAncestors(user, depth);
    }

    // ========== DEPOSIT & WITHDRAWAL ==========

    function recordDeposit(address user, uint256 bnbAmount) external onlyToken {
        // Settle existing rewards before updating deposit
        if (users[user].depositAmount > 0) {
            _settleRewards(user);
        }

        users[user].depositAmount += bnbAmount;
        users[user].lastSettleTime = block.timestamp;
        users[user].exited = false;

        emit Deposited(user, bnbAmount);
    }

    function recordWithdrawal(address user) external onlyToken {
        _settleRewards(user);
        users[user].exited = true;
    }

    // ========== REWARD CALCULATION ==========

    /**
     * @dev Settle rewards for a user (lazy evaluation)
     */
    function _settleRewards(address user) internal {
        UserInfo storage userInfo = users[user];

        if (userInfo.depositAmount == 0 || userInfo.exited) {
            return;
        }

        uint256 timeSinceLastSettle = block.timestamp - userInfo.lastSettleTime;
        if (timeSinceLastSettle == 0) {
            return;
        }

        // Calculate number of settlement periods (6 hours each)
        uint256 periods = timeSinceLastSettle / SETTLEMENT_INTERVAL;
        if (periods == 0) {
            return;
        }

        // Calculate static rewards
        uint256 staticRewards = _calculateStaticRewards(user, periods);
        userInfo.totalStaticRewards += staticRewards;

        // Calculate dynamic rewards (based on downline static rewards)
        uint256 dynamicRewards = _calculateDynamicRewards(user);
        userInfo.totalDynamicRewards += dynamicRewards;

        // Update last settle time
        userInfo.lastSettleTime = block.timestamp - (timeSinceLastSettle % SETTLEMENT_INTERVAL);

        emit RewardsSettled(user, staticRewards, dynamicRewards);

        // Check if user should exit
        _checkExit(user);
    }

    /**
     * @dev Calculate static rewards for a user
     * @param user User address
     * @param periods Number of 6-hour periods
     * @return BNB value of static rewards
     */
    function _calculateStaticRewards(address user, uint256 periods) internal view returns (uint256) {
        UserInfo storage userInfo = users[user];
        USCAMEXManager.RewardConfig memory rewardConfig = manager.rewardConfig();

        // Daily rate / 4 (since we settle every 6 hours)
        uint256 ratePerPeriod = rewardConfig.dailyStaticRate / 4;

        // staticReward = depositAmount * ratePerPeriod * periods / BASIS_POINTS
        return (userInfo.depositAmount * ratePerPeriod * periods) / BASIS_POINTS;
    }

    /**
     * @dev Calculate dynamic rewards (team rewards) for a user
     * @return BNB value of dynamic rewards
     */
    function _calculateDynamicRewards(address user) internal view returns (uint256) {
        uint256 directReferralCount = referralTree.getDirectReferralCount(user);
        if (directReferralCount == 0) {
            return 0;
        }

        // Determine how many generations this user can earn from
        uint256 unlockedGenerations = directReferralCount > 10 ? 10 : directReferralCount;

        uint256 totalDynamicRewards = 0;

        // For each unlocked generation, calculate rewards
        for (uint256 gen = 1; gen <= unlockedGenerations; gen++) {
            uint256 genRewardRate = manager.getTeamRewardRate(gen); // basis points

            // Get descendants at this generation level
            address[] memory descendants = referralTree.getDescendantsAtLevel(user, gen);

            // Sum up static rewards from this generation
            for (uint256 i = 0; i < descendants.length; i++) {
                UserInfo storage descendant = users[descendants[i]];

                // Only count non-exited users
                if (!descendant.exited && descendant.depositAmount > 0) {
                    // Get their static rewards earned in the last period
                    uint256 timeSinceSettle = block.timestamp - descendant.lastSettleTime;
                    uint256 periods = timeSinceSettle / SETTLEMENT_INTERVAL;

                    if (periods > 0) {
                        uint256 descendantStaticReward = _calculateStaticRewards(descendants[i], periods);
                        // Take percentage as team reward
                        totalDynamicRewards += (descendantStaticReward * genRewardRate) / BASIS_POINTS;
                    }
                }
            }
        }

        return totalDynamicRewards;
    }

    /**
     * @dev Check if user should exit (reached exit multiplier)
     */
    function _checkExit(address user) internal {
        UserInfo storage userInfo = users[user];
        USCAMEXManager.RewardConfig memory rewardConfig = manager.rewardConfig();

        uint256 totalRewards = userInfo.totalStaticRewards + userInfo.totalDynamicRewards;
        uint256 exitThreshold = (userInfo.depositAmount * rewardConfig.exitMultiplier) / 100;

        if (totalRewards >= exitThreshold) {
            userInfo.exited = true;
            emit Exited(user, totalRewards);
        }
    }

    // ========== PUBLIC FUNCTIONS ==========

    /**
     * @dev Claim rewards (settle and get pending amount)
     * @param user User address
     * @return staticRewards BNB value of static rewards
     * @return dynamicRewards BNB value of dynamic rewards
     */
    function claim(address user) external onlyToken returns (uint256 staticRewards, uint256 dynamicRewards) {
        _settleRewards(user);

        UserInfo storage userInfo = users[user];
        staticRewards = userInfo.totalStaticRewards;
        dynamicRewards = userInfo.totalDynamicRewards;

        // Reset accumulated rewards after claim
        userInfo.totalStaticRewards = 0;
        userInfo.totalDynamicRewards = 0;

        return (staticRewards, dynamicRewards);
    }

    /**
     * @dev Get pending rewards for a user (without settling)
     * @param user User address
     * @return staticRewards Pending static rewards (BNB value)
     * @return dynamicRewards Pending dynamic rewards (BNB value)
     */
    function getPendingRewards(address user) external view returns (uint256 staticRewards, uint256 dynamicRewards) {
        UserInfo storage userInfo = users[user];

        if (userInfo.depositAmount == 0 || userInfo.exited) {
            return (0, 0);
        }

        uint256 timeSinceLastSettle = block.timestamp - userInfo.lastSettleTime;
        uint256 periods = timeSinceLastSettle / SETTLEMENT_INTERVAL;

        if (periods > 0) {
            staticRewards = _calculateStaticRewards(user, periods);
            // Note: Dynamic rewards calculation is complex and gas-intensive, simplified here
        }

        // Add already accumulated rewards
        staticRewards += userInfo.totalStaticRewards;
        dynamicRewards += userInfo.totalDynamicRewards;

        return (staticRewards, dynamicRewards);
    }

    /**
     * @dev Check if user has exited
     */
    function hasExited(address user) external view returns (bool) {
        return users[user].exited;
    }

    /**
     * @dev Get user info
     */
    function getUserInfo(address user) external view returns (
        uint256 depositAmount,
        uint256 totalStaticRewards,
        uint256 totalDynamicRewards,
        uint256 lastSettleTime,
        bool exited
    ) {
        UserInfo storage userInfo = users[user];
        return (
            userInfo.depositAmount,
            userInfo.totalStaticRewards,
            userInfo.totalDynamicRewards,
            userInfo.lastSettleTime,
            userInfo.exited
        );
    }
}
