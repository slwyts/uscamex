// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract BuybackVault {
    address public immutable token;

    constructor(address token_) {
        require(token_ != address(0), "TOKEN");
        token = token_;
    }

    receive() external payable { }

    function execute(
        address target,
        uint256 value,
        bytes calldata data
    )
        external
        returns (bytes memory result)
    {
        require(msg.sender == token, "TOKEN_ONLY");
        (bool ok, bytes memory output) = target.call{ value: value }(data);
        require(ok, "VAULT_CALL");
        return output;
    }
}
