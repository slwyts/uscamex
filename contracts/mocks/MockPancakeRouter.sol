// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../interfaces/IPancakeFactory.sol";
import "../interfaces/IPancakePair.sol";
import "../interfaces/IWBNB.sol";

contract MockPancakeRouter {
    address public immutable factory;
    address public immutable WETH;

    function _sendBNB(address payable to, uint256 amount) internal {
        (bool success, ) = to.call{value: amount}("");
        require(success, "BNB transfer failed");
    }

    constructor(address _factory, address _wbnb) {
        factory = _factory;
        WETH = _wbnb;
    }

    receive() external payable {}

    function addLiquidity(
        address,
        address,
        uint256,
        uint256,
        uint256,
        uint256,
        address,
        uint256
    ) external pure returns (uint256, uint256, uint256) {
        revert("Unsupported");
    }

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256,
        uint256,
        address to,
        uint256
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity) {
        address pair = _getOrCreatePair(token, WETH);

        IERC20(token).transferFrom(msg.sender, address(this), amountTokenDesired);
        IWBNB(WETH).deposit{value: msg.value}();
        IWBNB(WETH).transfer(pair, msg.value);
        IERC20(token).transfer(pair, amountTokenDesired);

        liquidity = IPancakePair(pair).mint(to);
        return (amountTokenDesired, msg.value, liquidity);
    }

    function removeLiquidity(
        address,
        address,
        uint256,
        uint256,
        uint256,
        address,
        uint256
    ) external pure returns (uint256, uint256) {
        revert("Unsupported");
    }

    function removeLiquidityETH(
        address token,
        uint256 liquidity,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256
    ) external returns (uint256 amountToken, uint256 amountETH) {
        address pair = IPancakeFactory(factory).getPair(token, WETH);
        require(pair != address(0), "Pair not found");

        IERC20(pair).transferFrom(msg.sender, pair, liquidity);
        (uint256 amount0, uint256 amount1) = IPancakePair(pair).burn(address(this));
        (address token0, ) = _sortTokens(token, WETH);

        if (token0 == token) {
            amountToken = amount0;
            amountETH = amount1;
        } else {
            amountToken = amount1;
            amountETH = amount0;
        }

        require(amountToken >= amountTokenMin, "Insufficient token amount");
        require(amountETH >= amountETHMin, "Insufficient ETH amount");

        IERC20(token).transfer(to, amountToken);
        IWBNB(WETH).withdraw(amountETH);
        _sendBNB(payable(to), amountETH);
    }

    function swapExactTokensForTokens(
        uint256,
        uint256,
        address[] calldata,
        address,
        uint256
    ) external pure returns (uint256[] memory) {
        revert("Unsupported");
    }

    function swapTokensForExactTokens(
        uint256,
        uint256,
        address[] calldata,
        address,
        uint256
    ) external pure returns (uint256[] memory) {
        revert("Unsupported");
    }

    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external payable returns (uint256[] memory amounts) {
        require(path.length == 2, "Invalid path");
        require(path[0] == WETH, "Path must start with WETH");

        address tokenOut = path[1];
        address pair = IPancakeFactory(factory).getPair(tokenOut, WETH);
        require(pair != address(0), "Pair not found");

        uint256 amountOut = _previewAmountOut(pair, WETH, tokenOut, msg.value);
        require(amountOut >= amountOutMin, "Insufficient output amount");

        IWBNB(WETH).deposit{value: msg.value}();
        IWBNB(WETH).transfer(pair, msg.value);

        _swapOut(pair, WETH, amountOut, address(this));
        IERC20(tokenOut).transfer(to, amountOut);

        amounts = new uint256[](2);
        amounts[0] = msg.value;
        amounts[1] = amountOut;
    }

    function swapTokensForExactETH(
        uint256,
        uint256,
        address[] calldata,
        address,
        uint256
    ) external pure returns (uint256[] memory) {
        revert("Unsupported");
    }

    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external returns (uint256[] memory amounts) {
        uint256 amountOut = _swapExactTokensForETH(amountIn, amountOutMin, path, to);

        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = amountOut;
    }

    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external {
        _swapExactTokensForETH(amountIn, amountOutMin, path, to);
    }

    function _swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to
    ) internal returns (uint256 amountOut) {
        require(path.length == 2, "Invalid path");
        require(path[1] == WETH, "Path must end with WETH");

        address tokenIn = path[0];
        address pair = IPancakeFactory(factory).getPair(tokenIn, WETH);
        require(pair != address(0), "Pair not found");

        (uint256 reserveIn, uint256 reserveOut, ) = _getSwapReserves(pair, tokenIn, WETH);
        uint256 pairBalanceBefore = IERC20(tokenIn).balanceOf(pair);

        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).transfer(pair, amountIn);

        uint256 actualAmountIn = IERC20(tokenIn).balanceOf(pair) - pairBalanceBefore;
        amountOut = getAmountOut(actualAmountIn, reserveIn, reserveOut);
        require(amountOut >= amountOutMin, "Insufficient output amount");

        _swapOut(pair, tokenIn, amountOut, address(this));

        IWBNB(WETH).withdraw(amountOut);
        _sendBNB(payable(to), amountOut);
    }

    function swapETHForExactTokens(
        uint256,
        address[] calldata,
        address,
        uint256
    ) external pure returns (uint256[] memory) {
        revert("Unsupported");
    }

    function quote(uint256 amountA, uint256 reserveA, uint256 reserveB) external pure returns (uint256 amountB) {
        require(amountA > 0, "Insufficient amount");
        require(reserveA > 0 && reserveB > 0, "Insufficient liquidity");
        return (amountA * reserveB) / reserveA;
    }

    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) public pure returns (uint256 amountOut) {
        require(amountIn > 0, "Insufficient input amount");
        require(reserveIn > 0 && reserveOut > 0, "Insufficient liquidity");
        uint256 amountInWithFee = amountIn * 997;
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = reserveIn * 1000 + amountInWithFee;
        return numerator / denominator;
    }

    function getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut) external pure returns (uint256 amountIn) {
        require(amountOut > 0, "Insufficient output amount");
        require(reserveIn > 0 && reserveOut > amountOut, "Insufficient liquidity");
        uint256 numerator = reserveIn * amountOut * 1000;
        uint256 denominator = (reserveOut - amountOut) * 997;
        return numerator / denominator + 1;
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts) {
        require(path.length == 2, "Invalid path");
        address pair = IPancakeFactory(factory).getPair(path[0], path[1]);
        require(pair != address(0), "Pair not found");
        (uint256 reserveIn, uint256 reserveOut,) = _getSwapReserves(pair, path[0], path[1]);

        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = getAmountOut(amountIn, reserveIn, reserveOut);
    }

    function getAmountsIn(uint256 amountOut, address[] calldata path) external view returns (uint256[] memory amounts) {
        require(path.length == 2, "Invalid path");
        address pair = IPancakeFactory(factory).getPair(path[0], path[1]);
        require(pair != address(0), "Pair not found");
        (uint256 reserveIn, uint256 reserveOut,) = _getSwapReserves(pair, path[0], path[1]);

        amounts = new uint256[](2);
        amounts[1] = amountOut;
        amounts[0] = this.getAmountIn(amountOut, reserveIn, reserveOut);
    }

    function _getOrCreatePair(address tokenA, address tokenB) internal returns (address pair) {
        pair = IPancakeFactory(factory).getPair(tokenA, tokenB);
        if (pair == address(0)) {
            pair = IPancakeFactory(factory).createPair(tokenA, tokenB);
        }
    }

    function _sortTokens(address tokenA, address tokenB) internal pure returns (address, address) {
        return tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
    }

    function _getSwapReserves(
        address pair,
        address tokenIn,
        address tokenOut
    ) internal view returns (uint256 reserveIn, uint256 reserveOut, bool tokenInIsToken0) {
        (uint112 reserve0, uint112 reserve1, ) = IPancakePair(pair).getReserves();
        tokenInIsToken0 = IPancakePair(pair).token0() == tokenIn;
        require(
            (tokenInIsToken0 && IPancakePair(pair).token1() == tokenOut) ||
            (!tokenInIsToken0 && IPancakePair(pair).token0() == tokenOut),
            "Invalid pair"
        );

        if (tokenInIsToken0) {
            reserveIn = reserve0;
            reserveOut = reserve1;
        } else {
            reserveIn = reserve1;
            reserveOut = reserve0;
        }
    }

    function _previewAmountOut(
        address pair,
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) internal view returns (uint256) {
        (uint256 reserveIn, uint256 reserveOut, ) = _getSwapReserves(pair, tokenIn, tokenOut);
        return getAmountOut(amountIn, reserveIn, reserveOut);
    }

    function _swapOut(address pair, address tokenIn, uint256 amountOut, address to) internal {
        bool tokenInIsToken0 = IPancakePair(pair).token0() == tokenIn;
        if (tokenInIsToken0) {
            IPancakePair(pair).swap(0, amountOut, to, new bytes(0));
        } else {
            IPancakePair(pair).swap(amountOut, 0, to, new bytes(0));
        }
    }
}