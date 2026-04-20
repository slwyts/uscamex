// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./USCAMEXManager.sol";

contract TreasuryVault {
    USCAMEXManager public immutable manager;

    modifier onlyOwner() {
        require(msg.sender == owner(), "Not owner");
        _;
    }

    constructor(address managerAddress) {
        require(managerAddress != address(0), "Invalid manager");
        manager = USCAMEXManager(managerAddress);
    }

    function owner() public view returns (address) {
        return manager.owner();
    }

    receive() external payable {}

    function _sendBNB(address payable to, uint256 amount) internal {
        (bool success, ) = to.call{value: amount}("");
        require(success, "BNB transfer failed");
    }

    function withdrawBNB(address payable to, uint256 amount) external onlyOwner {
        require(to != address(0), "Invalid recipient");
        require(address(this).balance >= amount, "Insufficient BNB");
        _sendBNB(to, amount);
    }

    function withdrawToken(address token, address to, uint256 amount) external onlyOwner {
        require(token != address(0), "Invalid token");
        require(to != address(0), "Invalid recipient");
        IERC20(token).transfer(to, amount);
    }
}