// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract SwapReceiver {
    address public immutable controller;

    constructor(address _controller) {
        controller = _controller;
    }

    modifier onlyController() {
        require(msg.sender == controller, "Not controller");
        _;
    }

    function forwardToken(address token, address to, uint256 amount) external onlyController {
        IERC20(token).transfer(to, amount);
    }
}