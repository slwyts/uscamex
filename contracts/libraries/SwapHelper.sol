// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IPancakeRouter02.sol";
import "../interfaces/IPancakeFactory.sol";
import "../interfaces/IPancakePair.sol";

/**
 * @title SwapHelper
 * @dev Library for PancakeSwap V2 interactions
 */
library SwapHelper {
    /**
     * @dev Buy tokens with exact BNB
     * @param router PancakeSwap router address
     * @param token Token address to buy
     * @param bnbAmount Amount of BNB to spend
     * @param minTokens Minimum tokens to receive
     * @param to Recipient address
     * @return Amount of tokens received
     */
    function buyTokensWithExactBNB(
        address router,
        address token,
        uint256 bnbAmount,
        uint256 minTokens,
        address to
    ) internal returns (uint256) {
        address[] memory path = new address[](2);
        path[0] = IPancakeRouter02(router).WETH();
        path[1] = token;

        uint256[] memory amounts = IPancakeRouter02(router).swapExactETHForTokens{
            value: bnbAmount
        }(minTokens, path, to, block.timestamp + 300);

        return amounts[1];
    }

    /**
     * @dev Add liquidity with BNB and tokens
     * @param router PancakeSwap router address
     * @param token Token address
     * @param tokenAmount Amount of tokens to add
     * @param bnbAmount Amount of BNB to add
     * @param minTokens Minimum tokens to add
     * @param minBNB Minimum BNB to add
     * @param to Recipient of LP tokens
     * @return amountToken Amount of tokens added
     * @return amountBNB Amount of BNB added
     * @return liquidity Amount of LP tokens minted
     */
    function addLiquidityBNB(
        address router,
        address token,
        uint256 tokenAmount,
        uint256 bnbAmount,
        uint256 minTokens,
        uint256 minBNB,
        address to
    ) internal returns (uint256 amountToken, uint256 amountBNB, uint256 liquidity) {
        return IPancakeRouter02(router).addLiquidityETH{value: bnbAmount}(
            token,
            tokenAmount,
            minTokens,
            minBNB,
            to,
            block.timestamp + 300
        );
    }

    /**
     * @dev Get price of token in BNB (how much BNB for 1 token)
     * @param factory PancakeSwap factory address
     * @param token Token address
     * @param wbnb WBNB address
     * @return Price in BNB (with 18 decimals precision)
     */
    function getTokenPriceInBNB(
        address factory,
        address token,
        address wbnb
    ) internal view returns (uint256) {
        address pair = IPancakeFactory(factory).getPair(token, wbnb);
        if (pair == address(0)) {
            return 0;
        }

        (uint112 reserve0, uint112 reserve1, ) = IPancakePair(pair).getReserves();

        // Determine which reserve is which
        address token0 = IPancakePair(pair).token0();

        if (token0 == wbnb) {
            // reserve0 is WBNB, reserve1 is token
            // price = WBNB reserve / token reserve
            if (reserve1 == 0) return 0;
            return (uint256(reserve0) * 1e18) / uint256(reserve1);
        } else {
            // reserve0 is token, reserve1 is WBNB
            // price = WBNB reserve / token reserve
            if (reserve0 == 0) return 0;
            return (uint256(reserve1) * 1e18) / uint256(reserve0);
        }
    }

    /**
     * @dev Get amount of BNB equivalent for token amount
     * @param factory PancakeSwap factory address
     * @param token Token address
     * @param wbnb WBNB address
     * @param tokenAmount Amount of tokens
     * @return Equivalent BNB amount
     */
    function getBNBEquivalent(
        address factory,
        address token,
        address wbnb,
        uint256 tokenAmount
    ) internal view returns (uint256) {
        uint256 price = getTokenPriceInBNB(factory, token, wbnb);
        return (tokenAmount * price) / 1e18;
    }

    /**
     * @dev Get amount of tokens equivalent to BNB amount
     * @param factory PancakeSwap factory address
     * @param token Token address
     * @param wbnb WBNB address
     * @param bnbAmount Amount of BNB
     * @return Equivalent token amount
     */
    function getTokenEquivalent(
        address factory,
        address token,
        address wbnb,
        uint256 bnbAmount
    ) internal view returns (uint256) {
        uint256 price = getTokenPriceInBNB(factory, token, wbnb);
        if (price == 0) return 0;
        return (bnbAmount * 1e18) / price;
    }

    /**
     * @dev Get reserves from pair
     * @param factory PancakeSwap factory address
     * @param token Token address
     * @param wbnb WBNB address
     * @return tokenReserve Reserve of token
     * @return bnbReserve Reserve of BNB/WBNB
     */
    function getReserves(
        address factory,
        address token,
        address wbnb
    ) internal view returns (uint256 tokenReserve, uint256 bnbReserve) {
        address pair = IPancakeFactory(factory).getPair(token, wbnb);
        if (pair == address(0)) {
            return (0, 0);
        }

        (uint112 reserve0, uint112 reserve1, ) = IPancakePair(pair).getReserves();
        address token0 = IPancakePair(pair).token0();

        if (token0 == wbnb) {
            return (uint256(reserve1), uint256(reserve0));
        } else {
            return (uint256(reserve0), uint256(reserve1));
        }
    }

    /**
     * @dev Calculate optimal token amount for adding liquidity
     * @param factory PancakeSwap factory address
     * @param token Token address
     * @param wbnb WBNB address
     * @param bnbAmount Amount of BNB to add
     * @return Optimal amount of tokens to pair with BNB
     */
    function calculateOptimalTokenAmount(
        address factory,
        address token,
        address wbnb,
        uint256 bnbAmount
    ) internal view returns (uint256) {
        (uint256 tokenReserve, uint256 bnbReserve) = getReserves(factory, token, wbnb);

        if (tokenReserve == 0 || bnbReserve == 0) {
            // No liquidity yet, can't calculate optimal amount
            return 0;
        }

        // optimal token amount = (bnbAmount * tokenReserve) / bnbReserve
        return (bnbAmount * tokenReserve) / bnbReserve;
    }
}
