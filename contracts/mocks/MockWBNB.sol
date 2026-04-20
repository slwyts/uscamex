// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockWBNB is ERC20 {
    constructor() ERC20("Wrapped BNB", "WBNB") {}

    function _sendBNB(address payable to, uint256 amount) internal {
        (bool success, ) = to.call{value: amount}("");
        require(success, "BNB transfer failed");
    }

    function deposit() public payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        _sendBNB(payable(msg.sender), amount);
    }

    receive() external payable {
        deposit();
    }
}