// SPDX-License-Identifier: MIT
pragma solidity =0.8.35;

import { USCAMEX } from "../src/USCAMEX.sol";
import { BuybackVault } from "../src/BuybackVault.sol";

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

interface IPancakeRouterFork {
    function WETH() external view returns (address);

    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    )
        external
        payable;

    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    )
        external;
}

interface IPancakePairFork {
    function token0() external view returns (address);

    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32);
}

contract BscMainnetForkFlow {
    ForkVm internal constant vm = ForkVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant PANCAKE_V2_ROUTER = 0x10ED43C718714eb63d5aA57B78B54704E256024E;
    address internal constant OPERATOR = address(0x0A11CE);
    address internal constant USER = address(0x0B0B);
    address internal constant REFERRER = address(0x0C0C);
    address internal constant GENESIS_NODE = address(0x0111);
    address internal constant ATTACKER = address(0xBAD);
    address internal constant BURN = 0x000000000000000000000000000000000000dEaD;

    uint256 internal constant INITIAL_LP_BNB = 10 ether;
    uint256 internal constant ADMIN_RESERVE_TOKENS = 10_000_000 ether;

    receive() external payable { }

    function testBscMainnetForkBootstrapDepositOperatorFlow() public {
        if (!forkBsc()) return;

        USCAMEX token = deployInitializedToken();
        require(token.initialized(), "not-initialized");
        require(token.pair() != address(0), "no-pair");
        require(token.balanceOf(token.pair()) == token.totalSupply(), "lp-token-supply");

        (uint256 tokenReserve, uint256 bnbReserve) = pairReserves(token);
        require(tokenReserve == token.totalSupply(), "lp-token-reserve");
        require(bnbReserve == INITIAL_LP_BNB, "lp-bnb-reserve");

        vm.deal(USER, 2 ether);
        bind(token, USER, address(this));
        vm.prank(USER);
        (bool ok,) = payable(address(token)).call{ value: 1 ether }("");
        require(ok, "deposit");

        vm.prank(OPERATOR);
        require(token.pullPairTokens(10) > 0, "pull");
        vm.prank(OPERATOR);
        token.operatorCall(token.vault(), 0.1 ether, "");
        require(token.vault().balance == 0.1 ether, "vault-bnb");
    }

    function testBscMainnetForkReferralDepositConfigAndPermissions() public {
        if (!forkBsc()) return;

        USCAMEX fresh = new USCAMEX(PANCAKE_V2_ROUTER, address(this), OPERATOR);
        vm.deal(USER, 1 ether);
        vm.prank(USER);
        (bool ok,) = payable(address(fresh)).call{ value: 0.1 ether }("");
        require(!ok, "pre-init-user-bnb");

        tokenSeedAndInitialize(fresh);
        require(fresh.root() == address(this), "root");
        require(fresh.referrer(address(this)) == address(this), "root-bound");

        giveTokens(fresh, USER, fresh.bindCost());
        vm.prank(USER);
        (ok,) = address(fresh)
            .call(abi.encodeWithSignature("transfer(address,uint256)", REFERRER, fresh.bindCost()));
        require(!ok, "unbound-referrer");

        bind(fresh, REFERRER, address(this));
        bind(fresh, USER, REFERRER);
        require(fresh.referrer(USER) == REFERRER, "referrer-set");

        vm.prank(USER);
        ok = fresh.transfer(ATTACKER, 0);
        require(ok, "rebinding-zero-transfer-should-not-revert");
        require(fresh.referrer(USER) == REFERRER, "referrer-immutable");

        USCAMEX.ProtocolConfigInput memory config = fresh.getProtocolConfig();
        config.operator = OPERATOR;
        config.buyTaxBps = 300;
        config.sellTaxBps = 1000;
        config.minDeposit = uint128(0.2 ether);
        config.maxDeposit = uint128(4 ether);
        config.buyEnabled = true;
        vm.prank(ATTACKER);
        (ok,) =
            address(fresh).call(abi.encodeWithSelector(fresh.setProtocolConfig.selector, config));
        require(!ok, "non-owner-config");

        configureToken(fresh, OPERATOR, 300, 1000, uint128(0.2 ether), uint128(4 ether), true);
        vm.deal(USER, 6 ether);
        vm.prank(USER);
        (ok,) = payable(address(fresh)).call{ value: 0.1 ether }("");
        require(!ok, "below-min-deposit");
        vm.prank(USER);
        (ok,) = payable(address(fresh)).call{ value: 5 ether }("");
        require(!ok, "above-max-deposit");
        vm.prank(USER);
        (ok,) = payable(address(fresh)).call{ value: 1 ether }("");
        require(ok, "deposit");

        vm.prank(ATTACKER);
        (ok,) = address(fresh)
            .call(
                abi.encodeWithSelector(
                    fresh.operatorCall.selector, REFERRER, uint256(0.1 ether), bytes("")
                )
            );
        require(!ok, "non-operator-call");

        vm.prank(ATTACKER);
        (ok,) =
            address(fresh).call(abi.encodeWithSelector(fresh.pullPairTokens.selector, uint16(10)));
        require(!ok, "non-operator-pull");

        vm.prank(ATTACKER);
        (ok,) = address(fresh).call(abi.encodeWithSignature("burnFrom(address,uint256)", USER, 1));
        require(!ok, "non-operator-burn-from");

        vm.prank(ATTACKER);
        (ok,) = address(BuybackVault(payable(fresh.vault())))
            .call(
                abi.encodeWithSelector(
                    BuybackVault.execute.selector, REFERRER, uint256(0), bytes("")
                )
            );
        require(!ok, "direct-vault-execute");
    }

    function testBscMainnetForkRealRouterBuySellTaxesAndSwitches() public {
        if (!forkBsc()) return;

        USCAMEX token = deployInitializedToken();
        IPancakeRouterFork router = IPancakeRouterFork(PANCAKE_V2_ROUTER);
        address[] memory buyPath = new address[](2);
        buyPath[0] = router.WETH();
        buyPath[1] = address(token);

        vm.deal(USER, 5 ether);
        vm.prank(USER);
        (bool ok,) = PANCAKE_V2_ROUTER.call{ value: 0.1 ether }(
            abi.encodeWithSelector(
                router.swapExactETHForTokensSupportingFeeOnTransferTokens.selector,
                uint256(0),
                buyPath,
                USER,
                block.timestamp
            )
        );
        require(!ok, "buy-disabled");

        configureToken(token, OPERATOR, 300, 1000, uint128(0.1 ether), uint128(5 ether), true);
        uint256 contractTokenBeforeBuy = token.balanceOf(address(token));
        vm.prank(USER);
        router.swapExactETHForTokensSupportingFeeOnTransferTokens{ value: 0.1 ether }(
            0, buyPath, USER, block.timestamp
        );
        uint256 userTokens = token.balanceOf(USER);
        require(userTokens != 0, "buy-no-token");
        require(token.balanceOf(address(token)) > contractTokenBeforeBuy, "buy-tax-not-retained");

        address[] memory sellPath = new address[](2);
        sellPath[0] = address(token);
        sellPath[1] = router.WETH();
        uint256 contractTokenBeforeSell = token.balanceOf(address(token));
        uint256 userBnbBeforeSell = USER.balance;
        uint256 sellAmount = userTokens / 2;
        vm.prank(USER);
        require(token.approve(PANCAKE_V2_ROUTER, sellAmount), "approve-sell");
        vm.prank(USER);
        router.swapExactTokensForETHSupportingFeeOnTransferTokens(
            sellAmount, 0, sellPath, USER, block.timestamp
        );
        require(USER.balance > userBnbBeforeSell, "sell-no-bnb");
        require(token.balanceOf(address(token)) > contractTokenBeforeSell, "sell-tax-not-retained");
    }

    function testBscMainnetForkDeflationAndVaultBuybackThroughOperator() public {
        if (!forkBsc()) return;

        USCAMEX token = deployInitializedToken();
        configureToken(token, OPERATOR, 300, 1000, uint128(0.1 ether), uint128(5 ether), true);
        vm.deal(USER, 2 ether);
        bind(token, USER, address(this));
        vm.prank(USER);
        (bool ok,) = payable(address(token)).call{ value: 1 ether }("");
        require(ok, "deposit");

        (uint256 tokenReserveBefore, uint256 bnbReserveBefore) = pairReserves(token);
        vm.prank(OPERATOR);
        uint256 pulled = token.pullPairTokens(10);
        (uint256 tokenReserveAfter, uint256 bnbReserveAfter) = pairReserves(token);
        require(pulled > 0, "deflation-pull");
        require(tokenReserveAfter == tokenReserveBefore - pulled, "deflation-token-reserve");
        require(bnbReserveAfter == bnbReserveBefore, "deflation-bnb-reserve");

        vm.prank(OPERATOR);
        token.operatorCall(token.vault(), 0.1 ether, "");
        require(token.vault().balance == 0.1 ether, "vault-bnb");

        IPancakeRouterFork router = IPancakeRouterFork(PANCAKE_V2_ROUTER);
        address[] memory buyPath = new address[](2);
        buyPath[0] = router.WETH();
        buyPath[1] = address(token);
        bytes memory routerBuy = abi.encodeWithSelector(
            router.swapExactETHForTokensSupportingFeeOnTransferTokens.selector,
            uint256(0),
            buyPath,
            BURN,
            block.timestamp
        );
        bytes memory vaultExecute = abi.encodeWithSelector(
            BuybackVault.execute.selector, PANCAKE_V2_ROUTER, uint256(0.05 ether), routerBuy
        );
        uint256 burnBefore = token.balanceOf(BURN);
        vm.prank(OPERATOR);
        token.operatorCall(token.vault(), 0, vaultExecute);
        require(token.vault().balance == 0.05 ether, "vault-spent");
        require(token.balanceOf(BURN) > burnBefore, "buyback-burn-token");
    }

    function testBscMainnetForkLaunchLifecycleDefaultConfigAndDepositBatch() public {
        if (!forkBsc()) return;

        USCAMEX token = new USCAMEX(PANCAKE_V2_ROUTER, address(this), OPERATOR);
        token.operatorCall(
            address(token),
            0,
            abi.encodeWithSignature(
                "transfer(address,uint256)", address(this), ADMIN_RESERVE_TOKENS
            )
        );
        require(token.balanceOf(address(this)) == ADMIN_RESERVE_TOKENS, "admin-reserve");
        tokenSeedAndInitialize(token);

        (uint256 tokenReserve, uint256 bnbReserve) = pairReserves(token);
        require(tokenReserve == token.totalSupply() - ADMIN_RESERVE_TOKENS, "reserve-token");
        require(bnbReserve == INITIAL_LP_BNB, "reserve-bnb");

        USCAMEX.ProtocolConfigInput memory config = token.getProtocolConfig();
        require(!config.buyEnabled, "buy-default-off");
        require(config.lpBuildBps == 6000, "lp-bps");
        require(config.nodeBps == 1000, "node-bps");
        require(config.builderBuyBps == 1000, "builder-bps");
        require(config.vaultBps == 1000, "vault-bps");
        require(config.directPoolBps == 1000, "direct-pool-bps");
        require(config.directRewardBps == 1000, "direct-reward-bps");
        require(config.dailyStaticBps == 80, "static-bps");
        require(config.settlementPeriodsPerDay == 4, "periods");
        require(config.deflationHourlyBps == 10, "deflation-hourly");
        require(config.deflationDailyCapBps == 200, "deflation-cap");
        require(config.bindCost == 11 ether, "bind-cost");

        token.setNode(GENESIS_NODE, 1);
        require(token.nodeCount() == 1, "node-count");
        (address node, uint32 weight) = token.nodeAt(0);
        require(node == GENESIS_NODE && weight == 1, "node-weight");

        uint256 bindCost = token.bindCost();
        require(token.transfer(USER, bindCost), "fund-user-bind");
        vm.prank(USER);
        require(token.transfer(address(this), bindCost), "bind-user-root");
        require(token.referrer(USER) == address(this), "user-referrer");

        vm.deal(USER, 2 ether);
        vm.prank(USER);
        (bool ok,) = payable(address(token)).call{ value: 1 ether }("");
        require(ok, "user-deposit");

        (uint256 tokenReserveBeforeBatch, uint256 bnbReserveBeforeBatch) = pairReserves(token);
        uint256 vaultBefore = token.vault().balance;
        uint256 nodeBefore = GENESIS_NODE.balance;
        uint256 rootBefore = address(this).balance;

        USCAMEX.NodePayout[] memory payouts = new USCAMEX.NodePayout[](1);
        payouts[0] = USCAMEX.NodePayout({ to: GENESIS_NODE, amount: uint128(0.1 ether) });
        USCAMEX.DepositBatchParams memory params = USCAMEX.DepositBatchParams({
            user: USER,
            amount: uint128(1 ether),
            lpBnb: uint128(0.3 ether),
            lpTokenValueBnb: uint128(0.3 ether),
            minLpTokenOut: 1,
            minLpAddToken: 1,
            minLpAddBnb: 1,
            minLpLiquidityOut: 1,
            builderBnb: uint128(0.1 ether),
            minBuilderTokenOut: 1,
            vaultBnb: uint128(0.1 ether),
            directReferrer: address(this),
            directBnb: uint128(0.1 ether),
            deadline: block.timestamp + 1 hours,
            nodePayouts: payouts
        });

        vm.prank(OPERATOR);
        token.depositBatch(params);

        (uint256 tokenReserveAfterBatch, uint256 bnbReserveAfterBatch) = pairReserves(token);
        require(bnbReserveAfterBatch == bnbReserveBeforeBatch + 0.7 ether, "batch-bnb-reserve");
        require(tokenReserveAfterBatch < tokenReserveBeforeBatch, "batch-token-reserve");
        require(token.balanceOf(address(token)) > 0, "builder-token-self");
        require(token.vault().balance == vaultBefore + 0.1 ether, "batch-vault");
        require(GENESIS_NODE.balance == nodeBefore + 0.1 ether, "batch-node");
        require(address(this).balance == rootBefore + 0.1 ether, "batch-direct");
        require(address(token).balance == 0, "batch-spent-all");
    }

    function forkBsc() internal returns (bool) {
        string memory rpc = vm.envOr("BSC_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return false;
        vm.createSelectFork(rpc);
        return true;
    }

    function deployInitializedToken() internal returns (USCAMEX token) {
        token = new USCAMEX(PANCAKE_V2_ROUTER, address(this), OPERATOR);
        tokenSeedAndInitialize(token);
    }

    function tokenSeedAndInitialize(USCAMEX token) internal {
        vm.deal(address(this), 100 ether);
        (bool ok,) = payable(address(token)).call{ value: INITIAL_LP_BNB }("");
        require(ok, "seed-bnb");
        token.initializeLP();
    }

    function giveTokens(USCAMEX token, address to, uint256 amount) internal {
        token.pullPairTokensExact(amount);
        token.operatorCall(
            address(token), 0, abi.encodeWithSignature("transfer(address,uint256)", to, amount)
        );
    }

    function bind(USCAMEX token, address user, address upline) internal {
        uint256 cost = token.bindCost();
        if (token.balanceOf(user) < cost) giveTokens(token, user, cost - token.balanceOf(user));
        vm.prank(user);
        require(token.transfer(upline, cost), "bind-cost-transfer");
    }

    function configureToken(
        USCAMEX token,
        address nextOperator,
        uint16 nextBuyTaxBps,
        uint16 nextSellTaxBps,
        uint128 nextMinDeposit,
        uint128 nextMaxDeposit,
        bool nextBuyEnabled
    )
        internal
    {
        USCAMEX.ProtocolConfigInput memory config = token.getProtocolConfig();
        config.operator = nextOperator;
        config.buyTaxBps = nextBuyTaxBps;
        config.sellTaxBps = nextSellTaxBps;
        config.minDeposit = nextMinDeposit;
        config.maxDeposit = nextMaxDeposit;
        config.buyEnabled = nextBuyEnabled;
        token.setProtocolConfig(config);
    }

    function pairReserves(USCAMEX token)
        internal
        view
        returns (uint256 tokenReserve, uint256 bnbReserve)
    {
        IPancakePairFork pair = IPancakePairFork(token.pair());
        (uint112 reserve0, uint112 reserve1,) = pair.getReserves();
        if (pair.token0() == address(token)) {
            tokenReserve = uint256(reserve0);
            bnbReserve = uint256(reserve1);
        } else {
            tokenReserve = uint256(reserve1);
            bnbReserve = uint256(reserve0);
        }
    }
}
