// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract TreasuryVault is Ownable {
    constructor(address initialOwner) Ownable(initialOwner) {}

    receive() external payable {}

    function withdrawBNB(address payable to, uint256 amount) external onlyOwner {
        require(to != address(0), "Invalid recipient");
        require(address(this).balance >= amount, "Insufficient BNB");
        to.transfer(amount);
    }

    function withdrawToken(address token, address to, uint256 amount) external onlyOwner {
        require(token != address(0), "Invalid token");
        require(to != address(0), "Invalid recipient");
        IERC20(token).transfer(to, amount);
    }
}