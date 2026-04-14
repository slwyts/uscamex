// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/**
 * @title ReferralTree
 * @dev Library for managing referral relationships and tree traversal
 */
library ReferralTree {
    struct Tree {
        mapping(address => address) referrer; // user => their referrer
        mapping(address => address[]) directReferrals; // user => list of direct referrals
        mapping(address => uint256) directReferralCount; // user => count of direct referrals
    }

    /**
     * @dev Bind a referral relationship
     * @param self The tree storage
     * @param user The user to bind
     * @param referrer The referrer address
     */
    function bind(
        Tree storage self,
        address user,
        address referrer
    ) internal {
        require(user != address(0), "Invalid user");
        require(referrer != address(0), "Invalid referrer");
        require(user != referrer, "Cannot refer self");
        require(self.referrer[user] == address(0), "Already bound");

        self.referrer[user] = referrer;
        self.directReferrals[referrer].push(user);
        self.directReferralCount[referrer]++;
    }

    /**
     * @dev Get the referrer of a user
     * @param self The tree storage
     * @param user The user address
     * @return The referrer address (0x0 if none)
     */
    function getReferrer(
        Tree storage self,
        address user
    ) internal view returns (address) {
        return self.referrer[user];
    }

    /**
     * @dev Get direct referral count
     * @param self The tree storage
     * @param user The user address
     * @return The count of direct referrals
     */
    function getDirectReferralCount(
        Tree storage self,
        address user
    ) internal view returns (uint256) {
        return self.directReferralCount[user];
    }

    /**
     * @dev Get direct referrals list
     * @param self The tree storage
     * @param user The user address
     * @return Array of direct referral addresses
     */
    function getDirectReferrals(
        Tree storage self,
        address user
    ) internal view returns (address[] memory) {
        return self.directReferrals[user];
    }

    /**
     * @dev Get ancestors up to a certain depth (for team rewards)
     * @param self The tree storage
     * @param user The user address
     * @param depth Maximum depth (e.g., 10 for 10 generations)
     * @return ancestors Array of ancestor addresses (may be shorter than depth)
     */
    function getAncestors(
        Tree storage self,
        address user,
        uint256 depth
    ) internal view returns (address[] memory ancestors) {
        ancestors = new address[](depth);
        address current = user;
        uint256 count = 0;

        for (uint256 i = 0; i < depth; i++) {
            address parent = self.referrer[current];
            if (parent == address(0)) {
                break;
            }
            ancestors[count] = parent;
            count++;
            current = parent;
        }

        // Resize array if we found fewer ancestors than depth
        if (count < depth) {
            assembly {
                mstore(ancestors, count)
            }
        }

        return ancestors;
    }

    /**
     * @dev Check if user has a referrer
     * @param self The tree storage
     * @param user The user address
     * @return True if user has been referred
     */
    function hasReferrer(
        Tree storage self,
        address user
    ) internal view returns (bool) {
        return self.referrer[user] != address(0);
    }

    /**
     * @dev Get all descendants at a specific level
     * @param self The tree storage
     * @param user The user address
     * @param level The level (1 = direct referrals, 2 = second generation, etc.)
     * @return Array of addresses at that level
     */
    function getDescendantsAtLevel(
        Tree storage self,
        address user,
        uint256 level
    ) internal view returns (address[] memory) {
        require(level > 0, "Level must be > 0");

        if (level == 1) {
            return self.directReferrals[user];
        }

        // For deeper levels, we need to recursively traverse
        address[] memory currentLevel = self.directReferrals[user];

        for (uint256 i = 1; i < level; i++) {
            address[] memory nextLevel = new address[](0);
            uint256 totalCount = 0;

            // First, count total descendants at next level
            for (uint256 j = 0; j < currentLevel.length; j++) {
                totalCount += self.directReferrals[currentLevel[j]].length;
            }

            // Allocate array and populate
            nextLevel = new address[](totalCount);
            uint256 index = 0;
            for (uint256 j = 0; j < currentLevel.length; j++) {
                address[] memory children = self.directReferrals[currentLevel[j]];
                for (uint256 k = 0; k < children.length; k++) {
                    nextLevel[index] = children[k];
                    index++;
                }
            }

            currentLevel = nextLevel;
        }

        return currentLevel;
    }
}
