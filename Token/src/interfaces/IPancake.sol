// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPancakeRouter {
    function factory() external view returns (address);
    function WETH() external view returns (address);

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    )
        external
        payable
        returns (uint256 amountToken, uint256 amountETH, uint256 liquidity);

    function removeLiquidityETHSupportingFeeOnTransferTokens(
        address token,
        uint256 liquidity,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountETH);
}

interface IPancakeFactory {
    function getPair(address tokenA, address tokenB) external view returns (address);
}

interface IPancakePair {
    function sync() external;
    function approve(address spender, uint256 value) external returns (bool);
}
