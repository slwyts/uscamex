// SPDX-License-Identifier: MIT
pragma solidity =0.8.35;

import { USCAME } from "../src/USCAME.sol";
import { BuybackVault } from "../src/BuybackVault.sol";

interface Vm {
    function deal(address who, uint256 newBalance) external;
    function prank(address msgSender) external;
    function expectRevert(bytes calldata revertData) external;
    function startPrank(address msgSender) external;
    function stopPrank() external;
}

contract MiniTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function assertEq(uint256 a, uint256 b) internal pure {
        require(a == b, "assert uint");
    }

    function assertEq(address a, address b) internal pure {
        require(a == b, "assert address");
    }

    function assertTrue(bool value) internal pure {
        require(value, "assert true");
    }
}

contract MockPair {
    address public immutable token;
    address public immutable weth;
    uint112 public reserveToken;
    uint112 public reserveBnb;
    // Minimal LP-token surface so the router can pull LP back during exit.
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    constructor(address token_, address weth_) {
        token = token_;
        weth = weth_;
    }

    receive() external payable { }

    function buy(address to, uint256 amount) external {
        require(USCAME(payable(token)).transfer(to, amount), "transfer");
        sync();
    }

    function sync() public {
        reserveToken = uint112(USCAME(payable(token)).balanceOf(address(this)));
        reserveBnb = uint112(address(this).balance);
    }

    // token0 = WETH (bnb side), token1 = project token. Matches the contract's
    // _quoteBuyTokenOut ordering check (token0 != project token => reserveBnb = r0).
    function token0() external view returns (address) {
        return weth;
    }

    function token1() external view returns (address) {
        return token;
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserveBnb, reserveToken, 0);
    }

    function mintLp(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= value, "LP_ALLOWANCE");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        require(balanceOf[from] >= value, "LP_BAL");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        return true;
    }

    function burnFor(
        uint256 lpAmount,
        address tokenTo,
        address bnbTo
    )
        external
        returns (uint256 tokenOut, uint256 bnbOut)
    {
        require(balanceOf[address(this)] >= lpAmount, "LP");
        uint256 share = (lpAmount * 1e18) / totalSupply;
        tokenOut = (USCAME(payable(token)).balanceOf(address(this)) * share) / 1e18;
        bnbOut = (address(this).balance * share) / 1e18;
        balanceOf[address(this)] -= lpAmount;
        totalSupply -= lpAmount;
        if (tokenOut != 0) {
            require(USCAME(payable(token)).transfer(tokenTo, tokenOut), "tokenOut");
        }
        if (bnbOut != 0) {
            (bool ok,) = payable(bnbTo).call{ value: bnbOut }("");
            require(ok, "bnbOut");
        }
        sync();
    }
}

contract MockFactory {
    address public pair;

    function createPair(address token, address weth) external returns (address) {
        if (pair == address(0)) pair = address(new MockPair(token, weth));
        return pair;
    }

    function getPair(address, address) external view returns (address) {
        return pair;
    }
}

/// Minimal WETH mock. deposit() holds the native POL; transfer(to) forwards the
/// native value onward, so a MockPair receiving "WETH" actually receives native —
/// keeping MockPair's native-balance reserve model intact for the buy-to-self path.
contract MockWETH {
    mapping(address => uint256) public balanceOf;

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        require(balanceOf[msg.sender] >= value, "WETH_BAL");
        balanceOf[msg.sender] -= value;
        (bool ok,) = payable(to).call{ value: value }("");
        require(ok, "WETH_FWD");
        return true;
    }

    receive() external payable { }
}

contract MockRouter {
    address public immutable WETH;
    MockFactory public immutable factory;

    constructor() {
        factory = new MockFactory();
        WETH = address(new MockWETH());
    }

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256,
        uint256,
        address to,
        uint256
    )
        external
        payable
        returns (uint256, uint256, uint256)
    {
        address pair = factory.pair();
        if (pair == address(0)) pair = factory.createPair(token, WETH);
        require(
            USCAME(payable(token)).transferFrom(msg.sender, pair, amountTokenDesired),
            "transferFrom"
        );
        (bool ok,) = payable(pair).call{ value: msg.value }("");
        require(ok, "pair fund");
        MockPair(payable(pair)).sync();
        // Mint LP to `to` so subsequent exits have something to redeem.
        uint256 minted = msg.value == 0 ? 1 ether : msg.value;
        MockPair(payable(pair)).mintLp(to, minted);
        return (amountTokenDesired, msg.value, minted);
    }

    function removeLiquidityETHSupportingFeeOnTransferTokens(
        address token,
        uint256 liquidity,
        uint256,
        uint256,
        address to,
        uint256
    )
        external
        returns (uint256 amountETH)
    {
        address pair = factory.pair();
        require(pair != address(0), "NO_PAIR");
        // Pull LP from caller to the pair, then burn it.
        require(MockPair(payable(pair)).transferFrom(msg.sender, pair, liquidity), "lp pull");
        (, amountETH) = MockPair(payable(pair)).burnFor(liquidity, to, to);
    }
}

contract USCAMETest is MiniTest {
    USCAME private token;
    MockRouter private router;
    address private operator = address(0xA11CE);
    address private alice = address(0xA1);
    address private bob = address(0xB0B);
    address private carol = address(0xCA);
    address private dave = address(0xD0A0E);
    address private constant BURN = 0x000000000000000000000000000000000000dEaD;

    receive() external payable { }

    function setUp() public {
        router = new MockRouter();
        token = new USCAME(address(router), address(this), operator);
        vm.deal(address(this), 100 ether);
        (bool ok,) = payable(address(token)).call{ value: 10 ether }("");
        require(ok, "seed bnb");
        token.initializeLP();
    }

    function configureToken(
        address nextOperator,
        uint16 nextBuyTaxBps,
        uint16 nextSellTaxBps,
        uint128 nextMinDeposit,
        uint128 nextMaxDeposit,
        bool nextBuyEnabled
    )
        internal
    {
        USCAME.ProtocolConfigInput memory config = token.getProtocolConfig();
        config.operator = nextOperator;
        config.buyTaxBps = nextBuyTaxBps;
        config.sellTaxBps = nextSellTaxBps;
        config.minDeposit = nextMinDeposit;
        config.maxDeposit = nextMaxDeposit;
        config.buyEnabled = nextBuyEnabled;
        token.setProtocolConfig(config);
    }

    /// Move `amount` project tokens to `to` from the contract's self-custody
    /// (pull from pair, then operator-transfer out). Used to fund test users so
    /// they can pay the referral bind cost. The transfer is fee-exempt (sender is
    /// the contract), so `to` receives the full amount.
    function giveTokens(address to, uint256 amount) internal {
        vm.prank(operator);
        token.pullPairTokensExact(amount);
        vm.prank(operator);
        token.operatorCall(
            address(token), 0, abi.encodeWithSignature("transfer(address,uint256)", to, amount)
        );
    }

    /// Bind `user` to `upline` by paying the on-chain bindCost (default 11 tokens).
    /// Funds the user first so they hold enough to pay.
    function bind(address user, address upline) internal {
        uint256 cost = token.bindCost();
        if (token.balanceOf(user) < cost) giveTokens(user, cost - token.balanceOf(user));
        vm.prank(user);
        assertTrue(token.transfer(upline, cost));
    }

    function testInitializesLpOnceWithFullSupply() public {
        address pair = token.pair();
        assertTrue(token.initialized());
        assertTrue(token.vault() != address(0));
        assertEq(token.owner(), address(this));
        assertEq(token.root(), address(this));
        assertEq(token.referrer(address(this)), address(this));
        assertEq(token.balanceOf(pair), token.totalSupply());
        assertEq(pair.balance, 10 ether);
        vm.expectRevert(bytes("INIT"));
        token.initializeLP();
    }

    function testBurnAddressIsFeeExemptForBuyback() public {
        address pair = token.pair();
        assertTrue(token.feeExempt(BURN));
        uint256 amount = 1_000 ether;
        uint256 contractBefore = token.balanceOf(address(token));
        uint256 burnBefore = token.balanceOf(BURN);

        MockPair(payable(pair)).buy(BURN, amount);

        assertEq(token.balanceOf(address(token)), contractBefore);
        assertEq(token.balanceOf(BURN), burnBefore + amount);
    }

    function testBindCostTransferBindsReferralTree() public {
        uint256 cost = token.bindCost();
        assertEq(cost, 11 ether);

        // alice binds to root (address(this)) by paying bindCost; tokens really
        // land on the upline.
        giveTokens(alice, cost);
        uint256 rootBefore = token.balanceOf(address(this));
        vm.prank(alice);
        assertTrue(token.transfer(address(this), cost));
        assertEq(token.referrer(alice), address(this));
        assertEq(token.balanceOf(address(this)), rootBefore + cost);
        assertEq(token.balanceOf(alice), 0);

        // bob binds to alice (alice is already bound).
        giveTokens(bob, cost);
        vm.prank(bob);
        assertTrue(token.transfer(alice, cost));
        assertEq(token.referrer(bob), alice);

        // carol cannot bind to an unbound, non-root address (chain break guard).
        giveTokens(carol, cost);
        vm.prank(carol);
        (bool transferOk,) = address(token)
            .call(abi.encodeWithSignature("transfer(address,uint256)", address(0xDAD), cost));
        assertTrue(!transferOk);

        // alice already bound: paying bindCost again is an ordinary transfer, no rebind.
        giveTokens(alice, cost);
        vm.prank(alice);
        assertTrue(token.transfer(address(0xDAD), cost));
        assertEq(token.referrer(alice), address(this));
    }

    function testZeroTransferNoLongerBinds() public {
        // A zero-value transfer is now an ordinary ERC20 transfer; it must NOT bind.
        vm.prank(alice);
        assertTrue(token.transfer(address(this), 0));
        assertEq(token.referrer(alice), address(0));
    }

    function testRejectsUnboundDepositAndPreInitUserBnb() public {
        MockRouter freshRouter = new MockRouter();
        USCAME freshToken = new USCAME(address(freshRouter), address(this), operator);

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool preInitOk,) = payable(address(freshToken)).call{ value: 0.1 ether }("");
        assertTrue(!preInitOk);

        (bool seedOk,) = payable(address(freshToken)).call{ value: 1 ether }("");
        assertTrue(seedOk);
        freshToken.initializeLP();

        vm.prank(alice);
        (bool unboundOk,) = payable(address(freshToken)).call{ value: 0.1 ether }("");
        assertTrue(!unboundOk);

        // fund alice with bindCost from the fresh contract, then bind to root.
        uint256 cost = freshToken.bindCost();
        freshToken.pullPairTokensExact(cost);
        freshToken.operatorCall(
            address(freshToken),
            0,
            abi.encodeWithSignature("transfer(address,uint256)", alice, cost)
        );
        vm.prank(alice);
        assertTrue(freshToken.transfer(address(this), cost));
        vm.prank(alice);
        (bool boundOk,) = payable(address(freshToken)).call{ value: 0.1 ether }("");
        assertTrue(boundOk);
    }

    function testDepositBoundsAndEventsKeepBnbOnContract() public {
        bind(alice, address(this));
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = payable(address(token)).call{ value: 0.1 ether }("");
        assertTrue(ok);
        assertEq(address(token).balance, 0.1 ether);

        bind(bob, address(this));
        vm.deal(bob, 1 ether);
        vm.prank(bob);
        (bool belowMinOk,) = payable(address(token)).call{ value: 0.01 ether }("");
        assertTrue(!belowMinOk);
    }

    function testSetProtocolConfigGuardsAndOperatorRotation() public {
        USCAME.ProtocolConfigInput memory config = token.getProtocolConfig();
        config.operator = operator;
        config.buyTaxBps = 300;
        config.sellTaxBps = 1000;
        config.minDeposit = uint128(0.1 ether);
        config.maxDeposit = uint128(5 ether);
        config.buyEnabled = true;
        bytes memory configCall = abi.encodeWithSelector(token.setProtocolConfig.selector, config);
        vm.prank(bob);
        (bool nonOwnerOk,) = address(token).call(configCall);
        assertTrue(!nonOwnerOk);

        USCAME.ProtocolConfigInput memory badTax = token.getProtocolConfig();
        badTax.operator = operator;
        badTax.buyTaxBps = 2501;
        (bool badTaxOk,) =
            address(token).call(abi.encodeWithSelector(token.setProtocolConfig.selector, badTax));
        assertTrue(!badTaxOk);

        USCAME.ProtocolConfigInput memory badDeposit = token.getProtocolConfig();
        badDeposit.operator = operator;
        badDeposit.minDeposit = uint128(5 ether);
        badDeposit.maxDeposit = uint128(0.1 ether);
        (bool badDepositOk,) = address(token)
            .call(abi.encodeWithSelector(token.setProtocolConfig.selector, badDeposit));
        assertTrue(!badDepositOk);

        configureToken(dave, 300, 1000, uint128(0.2 ether), uint128(4 ether), true);
        assertEq(token.operator(), dave);
        assertTrue(token.feeExempt(dave));
        assertTrue(!token.feeExempt(operator));

        bytes memory opCall =
            abi.encodeWithSelector(token.operatorCall.selector, carol, uint256(0), bytes(""));
        vm.prank(operator);
        (bool oldOperatorOk,) = address(token).call(opCall);
        assertTrue(!oldOperatorOk);
        vm.prank(dave);
        token.operatorCall(carol, 0, "");
    }

    function testFullProtocolConfigAndNodesAreStoredOnChain() public {
        USCAME.ProtocolConfigInput memory config = token.getProtocolConfig();
        assertEq(uint256(config.lpBuildBps), 6000);
        assertEq(uint256(config.nodeBps), 1000);
        assertEq(uint256(config.teamRewardBps[0]), 1000);
        assertTrue(config.buybackEnabled);

        config.operator = dave;
        config.buyTaxBps = 400;
        config.sellTaxBps = 1200;
        config.minDeposit = uint128(0.2 ether);
        config.maxDeposit = uint128(4 ether);
        config.buyEnabled = true;
        config.lpBuildBps = 5000;
        config.nodeBps = 1500;
        config.builderBuyBps = 1000;
        config.vaultBps = 1500;
        config.directPoolBps = 1000;
        config.directRewardBps = 800;
        config.dailyStaticBps = 90;
        config.settlementPeriodsPerDay = 6;
        config.exitMultipleBps = 40_000;
        config.teamRewardBps[0] = 1100;
        config.deflationEnabled = false;
        config.deflationHourlyBps = 20;
        config.deflationDailyCapBps = 300;
        config.buybackEnabled = false;
        config.buybackPerMinute = uint128(0.2 ether);
        config.buyTaxBuilderBps = 150;
        config.buyTaxVaultBps = 250;
        config.sellTaxBuilderBps = 400;
        config.sellTaxOwnerBps = 400;
        config.sellTaxVaultBps = 400;

        token.setProtocolConfig(config);
        assertEq(token.operator(), dave);
        assertEq(uint256(token.buyTaxBps()), 400);
        assertEq(uint256(token.sellTaxBps()), 1200);
        assertEq(uint256(token.minDeposit()), 0.2 ether);
        assertEq(uint256(token.maxDeposit()), 4 ether);
        assertTrue(token.buyEnabled());
        assertEq(uint256(token.lpBuildBps()), 5000);
        assertEq(uint256(token.nodeBps()), 1500);
        assertEq(uint256(token.dailyStaticBps()), 90);
        assertEq(uint256(token.settlementPeriodsPerDay()), 6);
        assertEq(uint256(token.exitMultipleBps()), 40_000);
        assertEq(uint256(token.teamRewardBps(0)), 1100);
        assertTrue(!token.deflationEnabled());
        assertTrue(!token.buybackEnabled());
        assertEq(uint256(token.buybackPerMinute()), 0.2 ether);

        token.setNode(alice, 2);
        token.setNode(bob, 3);
        assertEq(token.nodeCount(), 2);
        (address firstNode, uint32 firstWeight) = token.nodeAt(0);
        assertEq(firstNode, alice);
        assertEq(uint256(firstWeight), 2);
        assertEq(uint256(token.nodeWeight(bob)), 3);
        token.setNode(alice, 0);
        assertEq(token.nodeCount(), 1);
        assertEq(uint256(token.nodeWeight(alice)), 0);
    }

    function testOwnershipTransferMovesRootToNewOwner() public {
        token.transferOwnership(dave);
        assertEq(token.owner(), dave);
        assertEq(token.root(), dave);
        assertEq(token.referrer(dave), dave);

        bind(alice, dave);
        assertEq(token.referrer(alice), dave);
    }

    function testBuyAndSellTaxes() public {
        address pair = token.pair();
        vm.expectRevert(bytes("BUY_OFF"));
        MockPair(payable(pair)).buy(alice, 100 ether);

        configureToken(operator, 300, 1000, uint128(0.1 ether), uint128(5 ether), true);
        uint256 reserveBefore = token.balanceOf(address(token));
        MockPair(payable(pair)).buy(alice, 100 ether);
        assertEq(token.balanceOf(alice), 97 ether);
        assertEq(token.balanceOf(address(token)), reserveBefore + 3 ether);

        vm.prank(alice);
        assertTrue(token.transfer(pair, 10 ether));
        assertEq(token.balanceOf(address(token)), reserveBefore + 4 ether);
        assertEq(token.balanceOf(pair), token.totalSupply() - 91 ether);
    }

    function testOperatorCanDistributeBnbAndPullPairTokens() public {
        bind(alice, address(this));
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = payable(address(token)).call{ value: 1 ether }("");
        assertTrue(ok);

        vm.expectRevert(bytes("OPERATOR"));
        vm.prank(bob);
        token.operatorCall(carol, 0.1 ether, "");

        vm.prank(operator);
        token.operatorCall(carol, 0.1 ether, "");
        assertEq(carol.balance, 0.1 ether);

        vm.prank(operator);
        token.operatorCall(token.vault(), 0.1 ether, "");
        address vault = token.vault();
        assertEq(vault.balance, 0.1 ether);
        vm.expectRevert(bytes("TOKEN_ONLY"));
        BuybackVault(payable(vault)).execute(carol, 0, "");

        address pair = token.pair();
        uint256 beforePair = token.balanceOf(pair);
        vm.prank(operator);
        uint256 pulled = token.pullPairTokens(100);
        assertEq(pulled, beforePair / 100);
        assertEq(token.balanceOf(pair), beforePair - pulled);
        assertEq(token.balanceOf(address(token)), pulled);
        assertEq(MockPair(payable(pair)).reserveBnb(), 10 ether);
    }

    function testOperatorExecutesDepositLiquidityAndDistributionFlow() public {
        bind(alice, address(this));
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = payable(address(token)).call{ value: 1 ether }("");
        assertTrue(ok);

        address pair = token.pair();
        uint256 pairTokenBefore = token.balanceOf(pair);
        uint256 pairBnbBefore = pair.balance;
        vm.prank(operator);
        uint256 pulled = token.pullPairTokens(100);
        uint256 tokenForLp = pulled / 10;

        vm.prank(operator);
        token.operatorCall(
            address(token),
            0,
            abi.encodeWithSignature("approve(address,uint256)", address(router), tokenForLp)
        );
        vm.prank(operator);
        token.operatorCall(
            address(router),
            0.3 ether,
            abi.encodeWithSignature(
                "addLiquidityETH(address,uint256,uint256,uint256,address,uint256)",
                address(token),
                tokenForLp,
                uint256(0),
                uint256(0),
                address(this),
                block.timestamp
            )
        );

        vm.prank(operator);
        token.operatorCall(carol, 0.1 ether, "");
        vm.prank(operator);
        token.operatorCall(token.vault(), 0.1 ether, "");

        assertEq(pair.balance, pairBnbBefore + 0.3 ether);
        assertEq(token.balanceOf(pair), pairTokenBefore - pulled + tokenForLp);
        assertEq(address(token).balance, 0.5 ether);
        assertEq(carol.balance, 0.1 ether);
        assertEq(token.vault().balance, 0.1 ether);
    }

    // --------------------------------------------------------------------
    // Self-custody LP & operatorRedeemLp
    // --------------------------------------------------------------------

    function testInitialLpStaysSelfCustodied() public {
        // Spec invariant: 100% of initial LP must live on the token contract
        // itself so the operator can orchestrate user exits without holding
        // any LP off-chain.
        address pair = token.pair();
        assertTrue(MockPair(payable(pair)).balanceOf(address(token)) > 0);
        assertEq(MockPair(payable(pair)).balanceOf(address(this)), 0);
    }

    function testOperatorRedeemLpBurnsTokenAndForwardsBnb() public {
        // Drive enough BNB into the contract that the pair has fresh liquidity
        // to redeem against, then exit a chunk back to `alice`.
        bind(alice, address(this));
        vm.deal(alice, 5 ether);
        vm.prank(alice);
        (bool ok,) = payable(address(token)).call{ value: 5 ether }("");
        assertTrue(ok);

        address pair = token.pair();
        uint256 totalLp = MockPair(payable(pair)).balanceOf(address(token));
        uint256 lpToBurn = totalLp / 10;
        uint256 bnbBefore = alice.balance;
        uint256 totalSupplyBefore = token.totalSupply();

        vm.prank(operator);
        (uint256 bnbReturned, uint256 tokenBurned) = token.operatorRedeemLp(alice, lpToBurn);

        assertTrue(bnbReturned > 0);
        assertTrue(tokenBurned > 0);
        assertEq(alice.balance, bnbBefore + bnbReturned);
        // Tokens that came back from LP must be burned (totalSupply drops).
        assertEq(token.totalSupply(), totalSupplyBefore - tokenBurned);
        // Contract no longer holds the burned-side LP.
        assertEq(MockPair(payable(pair)).balanceOf(address(token)), totalLp - lpToBurn);
    }

    function testOperatorRedeemLpWorksWhenBuyDisabledAndDoesNotCollectBuyTax() public {
        // Default buyEnabled is false. Redeeming protocol-held LP must still work and
        // must not treat the Pair -> Router token movement as a user buy.
        address pair = token.pair();
        uint256 totalLp = MockPair(payable(pair)).balanceOf(address(token));
        uint256 lpToBurn = totalLp / 20;
        uint256 contractTokenBefore = token.balanceOf(address(token));
        uint256 aliceBefore = alice.balance;

        vm.prank(operator);
        (uint256 bnbReturned, uint256 tokenBurned) = token.operatorRedeemLp(alice, lpToBurn);

        assertTrue(bnbReturned > 0);
        assertTrue(tokenBurned > 0);
        assertEq(alice.balance, aliceBefore + bnbReturned);
        assertEq(token.balanceOf(address(token)), contractTokenBefore);
    }

    function testOperatorRedeemLpOnlyOperator() public {
        vm.expectRevert(bytes("OPERATOR"));
        vm.prank(bob);
        token.operatorRedeemLp(alice, 1);
    }

    function testOperatorRedeemLpRejectsZeroArgs() public {
        vm.expectRevert(bytes("REDEEM"));
        vm.prank(operator);
        token.operatorRedeemLp(address(0), 1);

        vm.expectRevert(bytes("REDEEM"));
        vm.prank(operator);
        token.operatorRedeemLp(alice, 0);
    }

    // --------------------------------------------------------------------
    // pullPairTokensExact
    // --------------------------------------------------------------------

    function testPullPairTokensExactMovesPreciseAmount() public {
        address pair = token.pair();
        uint256 pairBefore = token.balanceOf(pair);
        uint256 want = 12_345 ether;
        vm.prank(operator);
        token.pullPairTokensExact(want);
        assertEq(token.balanceOf(pair), pairBefore - want);
        assertEq(token.balanceOf(address(token)), want);
        // sync() keeps Pair reserves authoritative.
        assertEq(uint256(MockPair(payable(pair)).reserveToken()), pairBefore - want);
    }

    function testPullPairTokensExactOnlyOperator() public {
        vm.expectRevert(bytes("OPERATOR"));
        vm.prank(bob);
        token.pullPairTokensExact(1 ether);
    }

    function testPullPairTokensExactRejectsBadAmount() public {
        address pair = token.pair();
        uint256 pairBal = token.balanceOf(pair);
        vm.expectRevert(bytes("AMOUNT"));
        vm.prank(operator);
        token.pullPairTokensExact(0);
        vm.expectRevert(bytes("AMOUNT"));
        vm.prank(operator);
        token.pullPairTokensExact(pairBal + 1);
    }

    // --------------------------------------------------------------------
    // burn / burnFrom
    // --------------------------------------------------------------------

    function testBurnReducesSenderBalance() public {
        // Get tokens into alice via a buy (3% tax accounted for).
        configureToken(operator, 300, 1000, uint128(0.1 ether), uint128(5 ether), true);
        address pair = token.pair();
        MockPair(payable(pair)).buy(alice, 100 ether);

        uint256 supplyBefore = token.totalSupply();
        uint256 aliceBefore = token.balanceOf(alice);
        vm.prank(alice);
        token.burn(10 ether);
        assertEq(token.balanceOf(alice), aliceBefore - 10 ether);
        assertEq(token.totalSupply(), supplyBefore - 10 ether);
    }

    function testBurnFromOnlyOperator() public {
        configureToken(operator, 300, 1000, uint128(0.1 ether), uint128(5 ether), true);
        address pair = token.pair();
        MockPair(payable(pair)).buy(alice, 100 ether);

        // Non-operator can't burnFrom.
        vm.expectRevert(bytes("OPERATOR"));
        vm.prank(bob);
        token.burnFrom(alice, 1 ether);

        uint256 supplyBefore = token.totalSupply();
        uint256 aliceBefore = token.balanceOf(alice);
        vm.prank(operator);
        token.burnFrom(alice, 5 ether);
        assertEq(token.balanceOf(alice), aliceBefore - 5 ether);
        assertEq(token.totalSupply(), supplyBefore - 5 ether);
    }

    // --------------------------------------------------------------------
    // Config validator branch coverage
    // --------------------------------------------------------------------

    function testProtocolConfigValidationCoversAllBranches() public {
        USCAME.ProtocolConfigInput memory base = token.getProtocolConfig();

        USCAME.ProtocolConfigInput memory zeroOp = base;
        zeroOp.operator = address(0);
        (bool a,) =
            address(token).call(abi.encodeWithSelector(token.setProtocolConfig.selector, zeroOp));
        assertTrue(!a);

        USCAME.ProtocolConfigInput memory highSell = base;
        highSell.sellTaxBps = 2501;
        (bool b,) =
            address(token).call(abi.encodeWithSelector(token.setProtocolConfig.selector, highSell));
        assertTrue(!b);

        USCAME.ProtocolConfigInput memory badDist = base;
        badDist.lpBuildBps = 5000;
        badDist.nodeBps = 5000;
        badDist.builderBuyBps = 5000; // sum > BPS
        (bool c,) =
            address(token).call(abi.encodeWithSelector(token.setProtocolConfig.selector, badDist));
        assertTrue(!c);

        USCAME.ProtocolConfigInput memory directRewardTooHigh = base;
        directRewardTooHigh.directPoolBps = 1000;
        directRewardTooHigh.directRewardBps = 2000;
        (bool d,) = address(token)
            .call(abi.encodeWithSelector(token.setProtocolConfig.selector, directRewardTooHigh));
        assertTrue(!d);

        USCAME.ProtocolConfigInput memory zeroPeriods = base;
        zeroPeriods.settlementPeriodsPerDay = 0;
        (bool e,) = address(token)
            .call(abi.encodeWithSelector(token.setProtocolConfig.selector, zeroPeriods));
        assertTrue(!e);

        USCAME.ProtocolConfigInput memory zeroExit = base;
        zeroExit.exitMultipleBps = 0;
        (bool f,) =
            address(token).call(abi.encodeWithSelector(token.setProtocolConfig.selector, zeroExit));
        assertTrue(!f);

        USCAME.ProtocolConfigInput memory deflationBad = base;
        deflationBad.deflationHourlyBps = 500;
        deflationBad.deflationDailyCapBps = 100; // hourly > daily
        (bool g,) = address(token)
            .call(abi.encodeWithSelector(token.setProtocolConfig.selector, deflationBad));
        assertTrue(!g);

        USCAME.ProtocolConfigInput memory buySplitBad = base;
        buySplitBad.buyTaxBps = 300;
        buySplitBad.buyTaxBuilderBps = 200;
        buySplitBad.buyTaxVaultBps = 200; // 400 > 300
        (bool h,) = address(token)
            .call(abi.encodeWithSelector(token.setProtocolConfig.selector, buySplitBad));
        assertTrue(!h);

        USCAME.ProtocolConfigInput memory sellSplitBad = base;
        sellSplitBad.sellTaxBps = 1000;
        sellSplitBad.sellTaxBuilderBps = 400;
        sellSplitBad.sellTaxOwnerBps = 400;
        sellSplitBad.sellTaxVaultBps = 400; // 1200 > 1000
        (bool i,) = address(token)
            .call(abi.encodeWithSelector(token.setProtocolConfig.selector, sellSplitBad));
        assertTrue(!i);

        USCAME.ProtocolConfigInput memory teamBad = base;
        teamBad.teamRewardBps[0] = 10_001; // > BPS
        (bool j,) =
            address(token).call(abi.encodeWithSelector(token.setProtocolConfig.selector, teamBad));
        assertTrue(!j);
    }

    // --------------------------------------------------------------------
    // Internal-address bnb routing (router/pair/vault/operator/owner)
    // --------------------------------------------------------------------

    function testInternalBnbSendersBypassDepositPath() public {
        // Funds from owner / operator / router / pair / vault must be
        // accepted as treasury top-ups even without a referrer binding.
        vm.deal(operator, 1 ether);
        vm.prank(operator);
        (bool a,) = payable(address(token)).call{ value: 0.5 ether }("");
        assertTrue(a);

        vm.deal(address(router), 1 ether);
        vm.prank(address(router));
        (bool b,) = payable(address(token)).call{ value: 0.5 ether }("");
        assertTrue(b);

        address pair = token.pair();
        vm.deal(pair, 1 ether);
        vm.prank(pair);
        (bool c,) = payable(address(token)).call{ value: 0.5 ether }("");
        assertTrue(c);
    }

    function testDepositAboveMaxIsRejected() public {
        bind(alice, address(this));
        vm.deal(alice, 10 ether);
        vm.prank(alice);
        (bool ok,) = payable(address(token)).call{ value: 6 ether }(""); // > 5 ether max
        assertTrue(!ok);
    }

    // --------------------------------------------------------------------
    // Misc guards
    // --------------------------------------------------------------------

    function testOperatorCallRejectsZeroTarget() public {
        vm.expectRevert(bytes("TARGET"));
        vm.prank(operator);
        token.operatorCall(address(0), 0, "");
    }

    function testTransferOwnershipRejectsZero() public {
        vm.expectRevert(bytes("OWNER_ZERO"));
        token.transferOwnership(address(0));
    }

    function testSetNodeRejectsZeroAddress() public {
        vm.expectRevert(bytes("NODE"));
        token.setNode(address(0), 1);
    }

    function testSetNodeRemovalAndReplacementMaintainsList() public {
        token.setNode(alice, 1);
        token.setNode(bob, 2);
        token.setNode(carol, 3);
        assertEq(token.nodeCount(), 3);

        // Remove the middle one — last element swaps into its slot.
        token.setNode(bob, 0);
        assertEq(token.nodeCount(), 2);
        assertEq(uint256(token.nodeWeight(bob)), 0);
        // Re-add bob, ensure list grows cleanly.
        token.setNode(bob, 7);
        assertEq(token.nodeCount(), 3);
        assertEq(uint256(token.nodeWeight(bob)), 7);
        // Update weight in place — list size unchanged.
        token.setNode(alice, 9);
        assertEq(token.nodeCount(), 3);
        assertEq(uint256(token.nodeWeight(alice)), 9);
    }

    function testSelfReferralBindingRejected() public {
        // alice cannot bind herself: a bindCost self-transfer (alice -> alice) is
        // excluded from the bind path (to != from guard), so it is an ordinary
        // transfer and leaves alice unbound.
        uint256 cost = token.bindCost();
        giveTokens(alice, cost);
        vm.prank(alice);
        assertTrue(token.transfer(alice, cost));
        assertEq(token.referrer(alice), address(0));
    }

    function testTaxedTransferToOperatorIsExemptAndFullAmount() public {
        configureToken(operator, 300, 1000, uint128(0.1 ether), uint128(5 ether), true);
        address pair = token.pair();
        MockPair(payable(pair)).buy(alice, 100 ether);
        // alice -> operator: operator is fee-exempt, so transfer carries
        // full amount with zero tax taken.
        uint256 aliceBefore = token.balanceOf(alice);
        uint256 contractBefore = token.balanceOf(address(token));
        vm.prank(alice);
        assertTrue(token.transfer(operator, 5 ether));
        assertEq(token.balanceOf(alice), aliceBefore - 5 ether);
        assertEq(token.balanceOf(operator), 5 ether);
        assertEq(token.balanceOf(address(token)), contractBefore);
    }

    // --------------------------------------------------------------------
    // operatorBatchCall: atomic multi-call + buy-gate bypass
    // --------------------------------------------------------------------

    function testOperatorBatchCallExecutesAtomically() public {
        // Fund the contract with BNB (via a bound user's deposit) and run several
        // payouts in one atomic batch.
        bind(alice, address(this));
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = payable(address(token)).call{ value: 1 ether }("");
        assertTrue(ok);
        assertEq(address(token).balance, 1 ether);

        address[] memory targets = new address[](3);
        uint256[] memory values = new uint256[](3);
        bytes[] memory datas = new bytes[](3);
        targets[0] = carol;
        values[0] = 0.1 ether;
        datas[0] = "";
        targets[1] = dave;
        values[1] = 0.2 ether;
        datas[1] = "";
        targets[2] = token.vault();
        values[2] = 0.1 ether;
        datas[2] = "";

        vm.prank(operator);
        token.operatorBatchCall(targets, values, datas);

        assertEq(carol.balance, 0.1 ether);
        assertEq(dave.balance, 0.2 ether);
        assertEq(token.vault().balance, 0.1 ether);
        assertEq(address(token).balance, 0.6 ether);
    }

    function testOperatorBatchCallRevertsAtomicallyOnFailure() public {
        bind(alice, address(this));
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = payable(address(token)).call{ value: 1 ether }("");
        assertTrue(ok);
        assertEq(address(token).balance, 1 ether);

        // Second call requests more BNB than the contract holds → that inner
        // call fails → require(ok,"OP_CALL") reverts the WHOLE batch. The first
        // transfer must be rolled back too (atomicity).
        address[] memory targets = new address[](2);
        uint256[] memory values = new uint256[](2);
        bytes[] memory datas = new bytes[](2);
        targets[0] = carol;
        values[0] = 0.1 ether;
        datas[0] = "";
        targets[1] = dave;
        values[1] = 100 ether; // exceeds contract balance → inner call fails
        datas[1] = "";

        vm.prank(operator);
        vm.expectRevert(bytes("OP_CALL"));
        token.operatorBatchCall(targets, values, datas);

        // nothing moved: full rollback
        assertEq(carol.balance, 0);
        assertEq(dave.balance, 0);
        assertEq(address(token).balance, 1 ether);
    }

    function testOperatorBatchCallOnlyOperatorAndLengthChecks() public {
        address[] memory targets = new address[](1);
        uint256[] memory values = new uint256[](2);
        bytes[] memory datas = new bytes[](1);
        targets[0] = carol;
        values[0] = 0;
        values[1] = 0;
        datas[0] = "";

        // length mismatch
        vm.prank(operator);
        vm.expectRevert(bytes("BATCH_LEN"));
        token.operatorBatchCall(targets, values, datas);

        // non-operator rejected
        address[] memory t = new address[](1);
        uint256[] memory v = new uint256[](1);
        bytes[] memory d = new bytes[](1);
        t[0] = carol;
        v[0] = 0;
        d[0] = "";
        vm.prank(bob);
        (bool nonOp,) =
            address(token).call(abi.encodeWithSelector(token.operatorBatchCall.selector, t, v, d));
        assertTrue(!nonOp);
    }

    function testOperatorBuyToSelfMovesTokensWithoutSwap() public {
        bind(alice, address(this));
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = payable(address(token)).call{ value: 1 ether }("");
        assertTrue(ok);

        address pair = token.pair();
        uint256 pairTokenBefore = token.balanceOf(pair);
        uint256 contractTokenBefore = token.balanceOf(address(token));
        uint256 pairBnbBefore = pair.balance;

        // Buy 0.1 BNB worth of tokens into the contract (no router swap → no INVALID_TO).
        vm.prank(operator);
        uint256 bought = token.operatorBuyToSelf(0.1 ether, 1);
        assertTrue(bought > 0);
        assertEq(token.balanceOf(address(token)), contractTokenBefore + bought);
        assertEq(token.balanceOf(pair), pairTokenBefore - bought);
        assertEq(pair.balance, pairBnbBefore + 0.1 ether);
    }

    function testOperatorBuildLpMintsLpToContract() public {
        bind(alice, address(this));
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = payable(address(token)).call{ value: 1 ether }("");
        assertTrue(ok);

        address pair = token.pair();
        uint256 lpBefore = MockPair(payable(pair)).balanceOf(address(token));
        uint256 pairBnbBefore = pair.balance;

        // 0.3 buy + 0.3 LP = 0.6 BNB consumed from the contract balance.
        vm.prank(operator);
        token.operatorBuildLp(0.3 ether, 0.3 ether, 1);

        // LP minted to the contract (self-custody for exits) and pool BNB +0.6.
        assertTrue(MockPair(payable(pair)).balanceOf(address(token)) > lpBefore);
        assertEq(pair.balance, pairBnbBefore + 0.6 ether);
    }

    function testDepositBatchExecutesFullDistributionAtomically() public {
        bind(alice, address(this));
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = payable(address(token)).call{ value: 1 ether }("");
        assertTrue(ok);

        address pair = token.pair();
        uint256 lpBefore = MockPair(payable(pair)).balanceOf(address(token));
        uint256 pairBnbBefore = pair.balance;
        uint256 contractTokenBefore = token.balanceOf(address(token));
        uint256 rootBnbBefore = address(this).balance;

        USCAME.NodePayout[] memory payouts = new USCAME.NodePayout[](1);
        payouts[0] = USCAME.NodePayout({ to: carol, amount: uint128(0.1 ether) });
        USCAME.DepositBatchParams memory params = USCAME.DepositBatchParams({
            user: alice,
            amount: uint128(1 ether),
            lpBnb: uint128(0.3 ether),
            lpTokenValueBnb: uint128(0.3 ether),
            minLpTokenOut: 1,
            builderBnb: uint128(0.1 ether),
            minBuilderTokenOut: 1,
            vaultBnb: uint128(0.1 ether),
            directReferrer: address(this),
            directBnb: uint128(0.1 ether),
            nodePayouts: payouts
        });

        vm.prank(operator);
        token.depositBatch(params);

        assertTrue(MockPair(payable(pair)).balanceOf(address(token)) > lpBefore);
        assertEq(pair.balance, pairBnbBefore + 0.7 ether);
        assertTrue(token.balanceOf(address(token)) > contractTokenBefore);
        assertEq(token.vault().balance, 0.1 ether);
        assertEq(carol.balance, 0.1 ether);
        assertEq(address(this).balance, rootBnbBefore + 0.1 ether);
        assertEq(address(token).balance, 0);
    }

    function testDepositBatchRevertsAtomicallyOnPayoutFailure() public {
        bind(alice, address(this));
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = payable(address(token)).call{ value: 1 ether }("");
        assertTrue(ok);

        address pair = token.pair();
        uint256 lpBefore = MockPair(payable(pair)).balanceOf(address(token));
        uint256 pairBnbBefore = pair.balance;
        uint256 pairTokenBefore = token.balanceOf(pair);
        uint256 contractBnbBefore = address(token).balance;
        uint256 vaultBefore = token.vault().balance;

        USCAME.NodePayout[] memory payouts = new USCAME.NodePayout[](1);
        payouts[0] = USCAME.NodePayout({ to: carol, amount: uint128(0.1 ether) });
        USCAME.DepositBatchParams memory params = USCAME.DepositBatchParams({
            user: alice,
            amount: uint128(1 ether),
            lpBnb: uint128(0.3 ether),
            lpTokenValueBnb: uint128(0.3 ether),
            minLpTokenOut: 1,
            builderBnb: uint128(0.1 ether),
            minBuilderTokenOut: 1,
            vaultBnb: uint128(0.1 ether),
            directReferrer: address(token),
            directBnb: uint128(0.1 ether),
            nodePayouts: payouts
        });

        vm.prank(operator);
        vm.expectRevert(bytes("PAYOUT"));
        token.depositBatch(params);

        assertEq(MockPair(payable(pair)).balanceOf(address(token)), lpBefore);
        assertEq(pair.balance, pairBnbBefore);
        assertEq(token.balanceOf(pair), pairTokenBefore);
        assertEq(address(token).balance, contractBnbBefore);
        assertEq(token.vault().balance, vaultBefore);
        assertEq(carol.balance, 0);
    }

    function testOperatorBuyToSelfRejectsSlippageAndNonOperator() public {
        bind(alice, address(this));
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = payable(address(token)).call{ value: 1 ether }("");
        assertTrue(ok);

        vm.prank(operator);
        vm.expectRevert(bytes("SLIPPAGE"));
        token.operatorBuyToSelf(0.1 ether, type(uint256).max);

        vm.prank(bob);
        (bool nonOp,) = address(token)
            .call(
                abi.encodeWithSignature(
                    "operatorBuyToSelf(uint256,uint256)", uint256(0.1 ether), uint256(1)
                )
            );
        assertTrue(!nonOp);
    }

    function testBuyGateBlocksUsersButAllowsOperatorContext() public {
        // Buy disabled for ordinary users.
        configureToken(operator, 300, 1000, uint128(0.1 ether), uint128(5 ether), false);
        address pair = token.pair();

        // Ordinary user buy (pair -> non-exempt user) must revert with BUY_OFF.
        (bool userBuyOk,) = address(pair)
            .call(abi.encodeWithSignature("buy(address,uint256)", alice, uint256(1 ether)));
        assertTrue(!userBuyOk);

        // A protocol buy routed through operatorBatchCall sets inOperatorContext,
        // so the same pair->user(here: contract, but exercise the gate via a
        // pair->bob path executed inside the batch) is allowed. We emulate the
        // swap's pair->recipient transfer by having the batch call MockPair.buy,
        // which performs token.transfer(from=pair). Recipient `dave` is NOT
        // fee-exempt, so without the operator-context bypass this would hit
        // BUY_OFF; inside the batch it must succeed.
        address[] memory targets = new address[](1);
        uint256[] memory values = new uint256[](1);
        bytes[] memory datas = new bytes[](1);
        targets[0] = pair;
        values[0] = 0;
        datas[0] = abi.encodeWithSignature("buy(address,uint256)", dave, uint256(1 ether));

        vm.prank(operator);
        token.operatorBatchCall(targets, values, datas);

        // dave received tokens net of buy tax (3%), proving the gate was bypassed
        // but tax still applied.
        assertTrue(token.balanceOf(dave) > 0);
    }
}
