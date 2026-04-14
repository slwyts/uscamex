// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

interface IWBNB {
    function deposit() external payable;
    function transfer(address to, uint value) external returns (bool);
    function withdraw(uint) external;
    function balanceOf(address owner) external view returns (uint);
    function approve(address spender, uint value) external returns (bool);
}
