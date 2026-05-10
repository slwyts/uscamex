// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { USCAME } from "../src/USCAME.sol";
import { BuybackVault } from "../src/BuybackVault.sol";

interface Vm {
    function deal(address who, uint256 newBalance) external;
    function prank(address msgSender) external;
    function expectRevert(bytes calldata revertData) external;
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

contract MockRouter {
    address public constant WETH = address(0xBEEF);
    MockFactory public immutable factory;

    constructor() {
        factory = new MockFactory();
    }

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256,
        uint256,
        address,
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
        return (amountTokenDesired, msg.value, 1 ether);
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

    function testZeroTransferBindsReferralTree() public {
        vm.prank(alice);
        assertTrue(token.transfer(address(this), 0));
        assertEq(token.referrer(alice), address(this));

        vm.prank(bob);
        assertTrue(token.transfer(alice, 0));
        assertEq(token.referrer(bob), alice);

        vm.prank(carol);
        (bool transferOk,) = address(token)
            .call(abi.encodeWithSignature("transfer(address,uint256)", address(0xDAD), uint256(0)));
        assertTrue(!transferOk);

        vm.prank(alice);
        assertTrue(token.transfer(address(0xDAD), 0));
        assertEq(token.referrer(alice), address(this));
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

        vm.prank(alice);
        assertTrue(freshToken.transfer(address(this), 0));
        vm.prank(alice);
        (bool boundOk,) = payable(address(freshToken)).call{ value: 0.1 ether }("");
        assertTrue(boundOk);
    }

    function testDepositBoundsAndEventsKeepBnbOnContract() public {
        vm.prank(alice);
        assertTrue(token.transfer(address(this), 0));
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = payable(address(token)).call{ value: 0.1 ether }("");
        assertTrue(ok);
        assertEq(address(token).balance, 0.1 ether);

        vm.prank(bob);
        assertTrue(token.transfer(address(this), 0));
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

        vm.prank(alice);
        assertTrue(token.transfer(dave, 0));
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
        vm.prank(alice);
        assertTrue(token.transfer(address(this), 0));
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
        vm.prank(alice);
        assertTrue(token.transfer(address(this), 0));
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
}
