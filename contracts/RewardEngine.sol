// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

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
        uint256 pendingStaticRewards; // Unclaimed static rewards (BNB value)
        uint256 pendingDynamicRewards; // Unclaimed dynamic rewards (BNB value)
        uint256 claimedStaticRewards; // Claimed static rewards in current cycle
        uint256 claimedDynamicRewards; // Claimed dynamic rewards in current cycle
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
        require(user != address(0), "Invalid user");
        require(bnbAmount > 0, "Invalid deposit");

        UserInfo storage userInfo = users[user];

        // Settle existing rewards before updating deposit
        if (userInfo.depositAmount > 0) {
            _settleRewards(user);
        } else {
            _resetCycle(userInfo);
        }

        userInfo.depositAmount += bnbAmount;
        userInfo.lastSettleTime = block.timestamp;
        userInfo.exited = false;

        emit Deposited(user, bnbAmount);
    }

    function recordWithdrawal(address user) external onlyToken {
        UserInfo storage userInfo = users[user];
        _settleRewards(user);
        userInfo.depositAmount = 0;
        userInfo.lastSettleTime = block.timestamp;
        userInfo.exited = true;
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
        if (staticRewards == 0) {
            userInfo.lastSettleTime = block.timestamp - (timeSinceLastSettle % SETTLEMENT_INTERVAL);
            return;
        }

        userInfo.pendingStaticRewards += staticRewards;

        // Update last settle time
        userInfo.lastSettleTime = block.timestamp - (timeSinceLastSettle % SETTLEMENT_INTERVAL);

        // Propagate dynamic rewards to ancestors based on this user's settled static rewards.
        _distributeDynamicRewards(user, staticRewards);

        emit RewardsSettled(user, staticRewards, 0);

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
        USCAMEXManager.RewardConfig memory rewardConfig = manager.getRewardConfig();

        // Daily rate / 4 (since we settle every 6 hours)
        uint256 ratePerPeriod = rewardConfig.dailyStaticRate / 4;

        // staticReward = depositAmount * ratePerPeriod * periods / BASIS_POINTS
        return (userInfo.depositAmount * ratePerPeriod * periods) / BASIS_POINTS;
    }

    function _distributeDynamicRewards(address sourceUser, uint256 sourceStaticRewards) internal {
        if (sourceStaticRewards == 0) {
            return;
        }

        address[] memory ancestors = referralTree.getAncestors(sourceUser, 10);

        for (uint256 index = 0; index < ancestors.length; index++) {
            address ancestor = ancestors[index];
            UserInfo storage ancestorInfo = users[ancestor];

            if (ancestorInfo.depositAmount == 0 || ancestorInfo.exited) {
                continue;
            }

            uint256 directReferralCount = referralTree.getDirectReferralCount(ancestor);
            uint256 unlockedGenerations = directReferralCount > 10 ? 10 : directReferralCount;
            uint256 generation = index + 1;

            if (generation > unlockedGenerations) {
                continue;
            }

            uint256 rewardRate = manager.getTeamRewardRate(generation);
            uint256 dynamicReward = (sourceStaticRewards * rewardRate) / BASIS_POINTS;

            if (dynamicReward == 0) {
                continue;
            }

            ancestorInfo.pendingDynamicRewards += dynamicReward;
            _checkExit(ancestor);
        }
    }

    /**
     * @dev Check if user should exit (reached exit multiplier)
     */
    function _checkExit(address user) internal {
        UserInfo storage userInfo = users[user];
        USCAMEXManager.RewardConfig memory rewardConfig = manager.getRewardConfig();

        if (userInfo.depositAmount == 0) {
            return;
        }

        uint256 totalRewards = userInfo.pendingStaticRewards + userInfo.pendingDynamicRewards +
            userInfo.claimedStaticRewards + userInfo.claimedDynamicRewards;
        uint256 exitThreshold = (userInfo.depositAmount * rewardConfig.exitMultiplier) / 100;

        if (!userInfo.exited && totalRewards >= exitThreshold) {
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
        UserInfo storage userInfo = users[user];

        if (userInfo.depositAmount > 0 && !userInfo.exited) {
            _settleRewards(user);
        }

        staticRewards = userInfo.pendingStaticRewards;
        dynamicRewards = userInfo.pendingDynamicRewards;

        // Reset accumulated rewards after claim
        userInfo.pendingStaticRewards = 0;
        userInfo.pendingDynamicRewards = 0;
        userInfo.claimedStaticRewards += staticRewards;
        userInfo.claimedDynamicRewards += dynamicRewards;

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
            return (userInfo.pendingStaticRewards, userInfo.pendingDynamicRewards);
        }

        uint256 timeSinceLastSettle = block.timestamp - userInfo.lastSettleTime;
        uint256 periods = timeSinceLastSettle / SETTLEMENT_INTERVAL;

        if (periods > 0) {
            staticRewards = _calculateStaticRewards(user, periods);
        }

        // Add already accumulated rewards
        staticRewards += userInfo.pendingStaticRewards;
        dynamicRewards += userInfo.pendingDynamicRewards;

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
            userInfo.pendingStaticRewards,
            userInfo.pendingDynamicRewards,
            userInfo.lastSettleTime,
            userInfo.exited
        );
    }

    function _resetCycle(UserInfo storage userInfo) internal {
        userInfo.pendingStaticRewards = 0;
        userInfo.pendingDynamicRewards = 0;
        userInfo.claimedStaticRewards = 0;
        userInfo.claimedDynamicRewards = 0;
        userInfo.lastSettleTime = 0;
        userInfo.exited = false;
    }
}
