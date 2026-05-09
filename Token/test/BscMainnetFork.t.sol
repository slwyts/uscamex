// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { USCAME } from "../src/USCAME.sol";

interface ForkVm {
    function envOr(
        string calldata key,
        string calldata defaultValue
    )
        external
        returns (string memory);
    function createSelectFork(string calldata url) external returns (uint256);
    function deal(address who, uint256 newBalance) external;
    function prank(address msgSender) external;
}

contract BscMainnetForkFlow {
    ForkVm internal constant vm = ForkVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant PANCAKE_V2_ROUTER = 0x10ED43C718714eb63d5aA57B78B54704E256024E;
    address internal constant OPERATOR = address(0x0A11CE);
    address internal constant USER = address(0x0B0B);

    receive() external payable { }

    function testBscMainnetForkBootstrapDepositOperatorFlow() public {
        string memory rpc = vm.envOr("BSC_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);

        USCAME token = new USCAME(PANCAKE_V2_ROUTER, OPERATOR);
        vm.deal(address(this), 100 ether);
        (bool ok,) = payable(address(token)).call{ value: 10 ether }("");
        require(ok, "seed-bnb");
        token.initializeLP();
        require(token.initialized(), "not-initialized");
        require(token.pair() != address(0), "no-pair");

        vm.deal(USER, 2 ether);
        vm.prank(USER);
        require(token.transfer(address(this), 0), "bind");
        vm.prank(USER);
        (ok,) = payable(address(token)).call{ value: 1 ether }("");
        require(ok, "deposit");

        vm.prank(OPERATOR);
        require(token.pullPairTokens(10) > 0, "pull");
        vm.prank(OPERATOR);
        token.operatorCall(token.vault(), 0.1 ether, "");
        require(token.vault().balance == 0.1 ether, "vault-bnb");
    }
}
