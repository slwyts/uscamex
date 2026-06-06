// SPDX-License-Identifier: MIT
pragma solidity =0.8.35;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { BuybackVault } from "./BuybackVault.sol";
import { IPancakeFactory, IPancakePair, IPancakeRouter, IWETH } from "./interfaces/IPancake.sol";

contract USCAME is ERC20, Ownable, ReentrancyGuard {
    uint256 public constant BPS = 10_000;

    struct ProtocolConfigInput {
        address operator;
        uint16 buyTaxBps;
        uint16 sellTaxBps;
        uint128 minDeposit;
        uint128 maxDeposit;
        bool buyEnabled;
        uint16 lpBuildBps;
        uint16 nodeBps;
        uint16 builderBuyBps;
        uint16 vaultBps;
        uint16 directPoolBps;
        uint16 directRewardBps;
        uint16 dailyStaticBps;
        uint8 settlementPeriodsPerDay;
        uint32 exitMultipleBps;
        uint16[10] teamRewardBps;
        bool deflationEnabled;
        uint16 deflationHourlyBps;
        uint16 deflationDailyCapBps;
        bool buybackEnabled;
        uint128 buybackPerMinute;
        uint16 buyTaxBuilderBps;
        uint16 buyTaxVaultBps;
        uint16 sellTaxBuilderBps;
        uint16 sellTaxOwnerBps;
        uint16 sellTaxVaultBps;
        uint128 bindCost;
    }

    struct NodePayout {
        address to;
        uint128 amount;
    }

    struct DepositBatchParams {
        uint128 lpBnb;
        uint128 lpTokenValueBnb;
        uint128 minLpTokenOut;
        uint128 builderBnb;
        uint128 minBuilderTokenOut;
        uint128 vaultBnb;
        address directReferrer;
        uint128 directBnb;
        NodePayout[] nodePayouts;
    }

    address public immutable router;
    address public immutable vault;
    address public operator;
    address public root;
    address public pair;
    bool public initialized;
    bool public buyEnabled;
    uint16 public buyTaxBps = 300;
    uint16 public sellTaxBps = 1000;
    uint128 public minDeposit = 0.1 ether;
    uint128 public maxDeposit = 5 ether;
    uint16 public lpBuildBps = 6000;
    uint16 public nodeBps = 1000;
    uint16 public builderBuyBps = 1000;
    uint16 public vaultBps = 1000;
    uint16 public directPoolBps = 1000;
    uint16 public directRewardBps = 1000;
    uint16 public dailyStaticBps = 80;
    uint8 public settlementPeriodsPerDay = 4;
    uint32 public exitMultipleBps = 30_000;
    uint16[10] public teamRewardBps;
    bool public deflationEnabled = true;
    uint16 public deflationHourlyBps = 10;
    uint16 public deflationDailyCapBps = 200;
    bool public buybackEnabled = true;
    uint128 public buybackPerMinute = 0.1 ether;
    uint16 public buyTaxBuilderBps = 100;
    uint16 public buyTaxVaultBps = 200;
    uint16 public sellTaxBuilderBps = 300;
    uint16 public sellTaxOwnerBps = 300;
    uint16 public sellTaxVaultBps = 400;
    /// Referral binding cost: a user binds an upline by transferring exactly this
    /// many project tokens to the upline address (default 11 tokens). Adjustable.
    uint128 public bindCost = 11 ether;
    mapping(address => address) public referrer;
    mapping(address => bool) public feeExempt;
    mapping(address => uint32) public nodeWeight;
    mapping(address => uint256) private nodeIndexPlusOne;
    address[] private nodes;

    /// Transient (EIP-1153) flag: set while an operator-driven call is executing
    /// (operatorCall / operatorBatchCall / depositBatch). Used by `_tax` to let protocol-owned
    /// buys (e.g. LP build, builder buy, buyback-to-burn) bypass the `buyEnabled`
    /// gate, which must only restrict ordinary users buying from the DEX.
    /// Auto-clears at end of the transaction, so it can never leak across txs.
    bool private transient inOperatorContext;

    event PairInitialized(address indexed pair, uint256 tokenAmount, uint256 bnbAmount);
    event RefBound(address indexed user, address indexed referrer);
    event Deposit(address indexed user, uint256 amount, address indexed referrer);
    event TaxCollected(address indexed from, address indexed to, uint256 amount, uint8 side);
    event OperatorCall(address indexed target, uint256 value, bytes data, bytes result);
    event PairTokensPulled(uint256 amount, uint16 bps);
    event TreasuryFunded(address indexed from, uint256 amount);
    event VaultCreated(address indexed vault);
    event ProtocolConfigUpdated(address indexed operator);
    event NodeUpdated(address indexed node, uint32 weight);
    event LpRedeemed(
        address indexed user, uint256 lpAmount, uint256 bnbReturned, uint256 tokenBurned
    );
    event DepositBatchExecuted(
        uint256 lpBnb,
        uint256 lpTokenValueBnb,
        uint256 builderBnb,
        uint256 vaultBnb,
        address indexed directReferrer,
        uint256 directBnb,
        uint256 nodeBnb
    );

    modifier onlyOperator() {
        require(msg.sender == owner() || msg.sender == operator, "OPERATOR");
        _;
    }

    constructor(
        address router_,
        address owner_,
        address operator_
    )
        ERC20("USCAMEX", "USCAME")
        Ownable(owner_)
    {
        require(router_ != address(0), "ROUTER");
        require(owner_ != address(0), "OWNER_ZERO");
        router = router_;
        vault = address(new BuybackVault(address(this)));
        root = owner_;
        operator = operator_ == address(0) ? owner_ : operator_;
        teamRewardBps[0] = 1000;
        teamRewardBps[1] = 900;
        teamRewardBps[2] = 800;
        teamRewardBps[3] = 700;
        teamRewardBps[4] = 600;
        teamRewardBps[5] = 500;
        teamRewardBps[6] = 500;
        teamRewardBps[7] = 500;
        teamRewardBps[8] = 500;
        teamRewardBps[9] = 500;
        referrer[root] = root;
        feeExempt[owner_] = true;
        feeExempt[address(this)] = true;
        feeExempt[operator] = true;
        feeExempt[vault] = true;
        _mint(address(this), 1_000_000_000 ether);
        emit RefBound(root, root);
        emit VaultCreated(vault);
    }

    receive() external payable {
        _receiveBnb();
    }

    fallback() external payable {
        _receiveBnb();
    }

    function initializeLP() external onlyOwner nonReentrant {
        require(!initialized, "INIT");
        uint256 tokenAmount = balanceOf(address(this));
        uint256 bnbAmount = address(this).balance;
        require(tokenAmount != 0 && bnbAmount != 0, "NO_LP");
        IPancakeRouter pancake = IPancakeRouter(router);
        _approve(address(this), router, tokenAmount);
        pancake.addLiquidityETH{ value: bnbAmount }(
            address(this), tokenAmount, 0, 0, address(this), block.timestamp
        );
        pair = IPancakeFactory(pancake.factory()).getPair(address(this), pancake.WETH());
        require(pair != address(0), "NO_PAIR");
        initialized = true;
        emit PairInitialized(pair, tokenAmount, bnbAmount);
    }

    /// Operator-driven exit: redeem `lpAmount` LP held by this contract,
    /// burn the returned project tokens, and forward the returned BNB to
    /// `user`. The token contract holds all LP itself (self-custody), so
    /// the offchain operator orchestrates user exits exclusively through
    /// this entry point.
    function operatorRedeemLp(
        address user,
        uint256 lpAmount
    )
        external
        onlyOperator
        nonReentrant
        returns (uint256 bnbReturned, uint256 tokenBurned)
    {
        require(user != address(0) && lpAmount != 0 && pair != address(0), "REDEEM");
        IPancakePair(pair).approve(router, lpAmount);
        uint256 tokenBefore = balanceOf(address(this));
        uint256 ethBefore = address(this).balance;
        IPancakeRouter(router)
            .removeLiquidityETHSupportingFeeOnTransferTokens(
                address(this), lpAmount, 0, 0, address(this), block.timestamp
            );
        unchecked {
            tokenBurned = balanceOf(address(this)) - tokenBefore;
            bnbReturned = address(this).balance - ethBefore;
        }
        if (tokenBurned != 0) {
            _burn(address(this), tokenBurned);
        }
        if (bnbReturned != 0) {
            (bool ok,) = user.call{ value: bnbReturned }("");
            require(ok, "REFUND");
        }
        emit LpRedeemed(user, lpAmount, bnbReturned, tokenBurned);
    }

    function transferOwnership(address nextOwner) public override onlyOwner {
        require(nextOwner != address(0), "OWNER_ZERO");
        if (owner() != operator) feeExempt[owner()] = false;
        feeExempt[nextOwner] = true;
        root = nextOwner;
        if (referrer[nextOwner] == address(0)) {
            referrer[nextOwner] = nextOwner;
            emit RefBound(nextOwner, nextOwner);
        }
        super.transferOwnership(nextOwner);
    }

    function setProtocolConfig(ProtocolConfigInput calldata next) external onlyOwner {
        _validateProtocolConfig(next);
        _setOperator(next.operator);
        buyTaxBps = next.buyTaxBps;
        sellTaxBps = next.sellTaxBps;
        minDeposit = next.minDeposit;
        maxDeposit = next.maxDeposit;
        buyEnabled = next.buyEnabled;
        lpBuildBps = next.lpBuildBps;
        nodeBps = next.nodeBps;
        builderBuyBps = next.builderBuyBps;
        vaultBps = next.vaultBps;
        directPoolBps = next.directPoolBps;
        directRewardBps = next.directRewardBps;
        dailyStaticBps = next.dailyStaticBps;
        settlementPeriodsPerDay = next.settlementPeriodsPerDay;
        exitMultipleBps = next.exitMultipleBps;
        for (uint256 index = 0; index < 10; ++index) {
            teamRewardBps[index] = next.teamRewardBps[index];
        }
        deflationEnabled = next.deflationEnabled;
        deflationHourlyBps = next.deflationHourlyBps;
        deflationDailyCapBps = next.deflationDailyCapBps;
        buybackEnabled = next.buybackEnabled;
        buybackPerMinute = next.buybackPerMinute;
        buyTaxBuilderBps = next.buyTaxBuilderBps;
        buyTaxVaultBps = next.buyTaxVaultBps;
        sellTaxBuilderBps = next.sellTaxBuilderBps;
        sellTaxOwnerBps = next.sellTaxOwnerBps;
        sellTaxVaultBps = next.sellTaxVaultBps;
        bindCost = next.bindCost;
        emit ProtocolConfigUpdated(operator);
    }

    function getProtocolConfig() external view returns (ProtocolConfigInput memory config) {
        config.operator = operator;
        config.buyTaxBps = buyTaxBps;
        config.sellTaxBps = sellTaxBps;
        config.minDeposit = minDeposit;
        config.maxDeposit = maxDeposit;
        config.buyEnabled = buyEnabled;
        config.lpBuildBps = lpBuildBps;
        config.nodeBps = nodeBps;
        config.builderBuyBps = builderBuyBps;
        config.vaultBps = vaultBps;
        config.directPoolBps = directPoolBps;
        config.directRewardBps = directRewardBps;
        config.dailyStaticBps = dailyStaticBps;
        config.settlementPeriodsPerDay = settlementPeriodsPerDay;
        config.exitMultipleBps = exitMultipleBps;
        for (uint256 index = 0; index < 10; ++index) {
            config.teamRewardBps[index] = teamRewardBps[index];
        }
        config.deflationEnabled = deflationEnabled;
        config.deflationHourlyBps = deflationHourlyBps;
        config.deflationDailyCapBps = deflationDailyCapBps;
        config.buybackEnabled = buybackEnabled;
        config.buybackPerMinute = buybackPerMinute;
        config.buyTaxBuilderBps = buyTaxBuilderBps;
        config.buyTaxVaultBps = buyTaxVaultBps;
        config.sellTaxBuilderBps = sellTaxBuilderBps;
        config.sellTaxOwnerBps = sellTaxOwnerBps;
        config.sellTaxVaultBps = sellTaxVaultBps;
        config.bindCost = bindCost;
    }

    function setNode(address node, uint32 weight) external onlyOwner {
        require(node != address(0), "NODE");
        uint256 indexPlusOne = nodeIndexPlusOne[node];
        if (weight == 0) {
            if (indexPlusOne != 0) {
                uint256 index = indexPlusOne - 1;
                address lastNode = nodes[nodes.length - 1];
                nodes[index] = lastNode;
                nodeIndexPlusOne[lastNode] = index + 1;
                nodes.pop();
                delete nodeIndexPlusOne[node];
                delete nodeWeight[node];
            }
            emit NodeUpdated(node, 0);
            return;
        }
        if (indexPlusOne == 0) {
            nodes.push(node);
            nodeIndexPlusOne[node] = nodes.length;
        }
        nodeWeight[node] = weight;
        emit NodeUpdated(node, weight);
    }

    function nodeCount() external view returns (uint256) {
        return nodes.length;
    }

    function nodeAt(uint256 index) external view returns (address node, uint32 weight) {
        node = nodes[index];
        weight = nodeWeight[node];
    }

    function operatorCall(
        address target,
        uint256 value,
        bytes calldata data
    )
        external
        onlyOperator
        nonReentrant
        returns (bytes memory result)
    {
        require(target != address(0), "TARGET");
        inOperatorContext = true;
        (bool ok, bytes memory output) = target.call{ value: value }(data);
        require(ok, "OP_CALL");
        inOperatorContext = false;
        emit OperatorCall(target, value, data, output);
        return output;
    }

    /// Atomic batch of generic operator calls. Either every call succeeds or the
    /// whole transaction reverts. Deposit execution uses the typed `depositBatch`
    /// entry point below so self-calls do not trip onlyOperator/nonReentrant guards.
    /// `inOperatorContext` stays set for the whole batch so protocol-owned buys
    /// bypass the `buyEnabled` user gate.
    function operatorBatchCall(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata datas
    )
        external
        onlyOperator
        nonReentrant
        returns (bytes[] memory results)
    {
        uint256 len = targets.length;
        require(len != 0 && values.length == len && datas.length == len, "BATCH_LEN");
        results = new bytes[](len);
        inOperatorContext = true;
        for (uint256 i = 0; i < len; ++i) {
            address target = targets[i];
            require(target != address(0), "TARGET");
            (bool ok, bytes memory output) = target.call{ value: values[i] }(datas[i]);
            require(ok, "OP_CALL");
            results[i] = output;
            emit OperatorCall(target, values[i], datas[i], output);
        }
        inOperatorContext = false;
    }

    /// Execute one user's full deposit distribution atomically without self-calling
    /// privileged external functions. The offchain worker computes the amounts and
    /// slippage floors, while the contract spends the already-received deposit BNB:
    /// LP build, builder buy, vault credit, node payouts, and direct referral payout.
    function depositBatch(DepositBatchParams calldata params) external onlyOperator nonReentrant {
        require(initialized && pair != address(0), "NOT_READY");
        uint256 nodeBnb;
        inOperatorContext = true;

        if (params.lpBnb != 0 || params.lpTokenValueBnb != 0) {
            _operatorBuildLp(params.lpTokenValueBnb, params.lpBnb, params.minLpTokenOut);
        }
        if (params.builderBnb != 0) {
            _operatorBuyToSelf(params.builderBnb, params.minBuilderTokenOut);
        }
        if (params.vaultBnb != 0) {
            _sendBnb(vault, params.vaultBnb);
        }
        for (uint256 i = 0; i < params.nodePayouts.length; ++i) {
            NodePayout calldata payout = params.nodePayouts[i];
            if (payout.amount == 0) continue;
            nodeBnb += payout.amount;
            _sendBnb(payout.to, payout.amount);
        }
        if (params.directBnb != 0) {
            _sendBnb(params.directReferrer, params.directBnb);
        }

        inOperatorContext = false;
        emit DepositBatchExecuted(
            params.lpBnb,
            params.lpTokenValueBnb,
            params.builderBnb,
            params.vaultBnb,
            params.directReferrer,
            params.directBnb,
            nodeBnb
        );
    }

    function pullPairTokens(uint16 bps) external onlyOperator returns (uint256 amount) {
        require(pair != address(0) && bps <= BPS, "PULL");
        amount = (balanceOf(pair) * bps) / BPS;
        if (amount != 0) {
            super._update(pair, address(this), amount);
            IPancakePair(pair).sync();
        }
        emit PairTokensPulled(amount, bps);
    }

    /// Pull an exact amount of project tokens out of the Pair contract into
    /// this contract's self-custody. Used by the offchain deposit pipeline
    /// when it needs a precise token quantity to pair against the user's
    /// BNB for `addLiquidityETH`. Single-sided extraction; `sync()` keeps
    /// Pair reserves authoritative so AMM math remains consistent.
    function pullPairTokensExact(uint256 amount) external onlyOperator {
        require(pair != address(0), "PULL");
        require(amount != 0 && amount <= balanceOf(pair), "AMOUNT");
        super._update(pair, address(this), amount);
        IPancakePair(pair).sync();
        emit PairTokensPulled(amount, 0);
    }

    /// Single-sided "buy" that keeps the bought tokens in the contract WITHOUT a
    /// router swap (UniswapV2 forbids swap recipients equal to token0/token1, which
    /// the project token always is). Instead: wrap `bnbAmount` POL into the pair's
    /// WETH side, donate it to the pair, then single-sided extract the equivalent
    /// project tokens to the contract and `sync()`. Net effect == buying on the AMM
    /// (pool BNB up, pool tokens down, price up), with the bought tokens self-custodied.
    /// `minTokenOut` guards against adverse reserve moves. Returns tokens extracted.
    function operatorBuyToSelf(
        uint256 bnbAmount,
        uint256 minTokenOut
    )
        public
        onlyOperator
        returns (uint256 tokenOut)
    {
        return _operatorBuyToSelf(bnbAmount, minTokenOut);
    }

    function _operatorBuyToSelf(
        uint256 bnbAmount,
        uint256 minTokenOut
    )
        internal
        returns (uint256 tokenOut)
    {
        require(pair != address(0) && bnbAmount != 0, "BUY");
        tokenOut = _quoteBuyTokenOut(bnbAmount);
        require(tokenOut >= minTokenOut && tokenOut != 0, "SLIPPAGE");
        require(tokenOut <= balanceOf(pair), "POOL_TOKENS");
        address weth = IPancakeRouter(router).WETH();
        IWETH(weth).deposit{ value: bnbAmount }();
        require(IWETH(weth).transfer(pair, bnbAmount), "WETH_XFER");
        super._update(pair, address(this), tokenOut);
        IPancakePair(pair).sync();
        emit PairTokensPulled(tokenOut, 0);
    }

    /// Build LP from a deposit's LP-build BNB, atomically and without a swap.
    /// `swapBnb` is used to buy project tokens into the contract (operatorBuyToSelf);
    /// `lpBnb` is paired with those tokens via addLiquidityETH. LP is minted to the
    /// contract (self-custody) so user exits via operatorRedeemLp keep working.
    /// Surplus tokens not consumed by addLiquidity stay in the contract (per spec).
    function operatorBuildLp(
        uint256 swapBnb,
        uint256 lpBnb,
        uint256 minTokenOut
    )
        external
        onlyOperator
        nonReentrant
    {
        _operatorBuildLp(swapBnb, lpBnb, minTokenOut);
    }

    function _operatorBuildLp(uint256 swapBnb, uint256 lpBnb, uint256 minTokenOut) internal {
        require(pair != address(0) && swapBnb != 0 && lpBnb != 0, "LP_ARGS");
        uint256 bought = _operatorBuyToSelf(swapBnb, minTokenOut);
        _approve(address(this), router, bought);
        IPancakeRouter(router).addLiquidityETH{ value: lpBnb }(
            address(this), bought, 0, 0, address(this), block.timestamp
        );
    }

    function _sendBnb(address to, uint256 amount) internal {
        require(to != address(0), "PAYOUT");
        (bool ok,) = to.call{ value: amount }("");
        require(ok, "PAYOUT");
    }

    /// Quote project-token output for buying with `bnbAmount`, using live reserves
    /// and the standard UniswapV2 0.3% fee (matches QuickSwap/Sushi pairs).
    function _quoteBuyTokenOut(uint256 bnbAmount) internal view returns (uint256) {
        (uint112 r0, uint112 r1,) = IPancakePair(pair).getReserves();
        address token0 = IPancakePair(pair).token0();
        (uint256 reserveBnb, uint256 reserveToken) =
            token0 == address(this) ? (uint256(r1), uint256(r0)) : (uint256(r0), uint256(r1));
        require(reserveBnb != 0 && reserveToken != 0, "NO_RESERVES");
        uint256 amountInWithFee = bnbAmount * 997;
        return (amountInWithFee * reserveToken) / (reserveBnb * 1000 + amountInWithFee);
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    function burnFrom(address from, uint256 amount) external onlyOperator {
        _burn(from, amount);
    }

    function _receiveBnb() internal {
        if (!initialized) {
            require(msg.sender == owner(), "NOT_READY");
            emit TreasuryFunded(msg.sender, msg.value);
            return;
        }
        if (
            msg.sender == owner() || msg.sender == operator || msg.sender == router
                || msg.sender == pair || msg.sender == vault
        ) {
            emit TreasuryFunded(msg.sender, msg.value);
            return;
        }
        require(referrer[msg.sender] != address(0), "NO_REF");
        require(msg.value >= minDeposit && msg.value <= maxDeposit, "DEPOSIT");
        emit Deposit(msg.sender, msg.value, referrer[msg.sender]);
    }

    function _update(address from, address to, uint256 amount) internal override {
        // Referral binding: an unbound user binds `to` as their upline by transferring
        // exactly `bindCost` project tokens to that upline. The tokens are really
        // delivered to the upline (no tax on this path); only the bind side-effect is
        // added. A zero-value transfer is now an ordinary ERC20 transfer (no binding).
        // Fee-exempt senders (contract/operator/owner) never bind.
        if (
            amount == bindCost && bindCost != 0 && from != address(0) && to != address(0)
                && referrer[from] == address(0) && to != from && !feeExempt[from]
        ) {
            _bind(from, to);
            return super._update(from, to, amount);
        }
        (uint256 tax, uint8 side) = _tax(from, to, amount);
        if (tax != 0) {
            super._update(from, address(this), tax);
            emit TaxCollected(from, to, tax, side);
        }
        super._update(from, to, amount - tax);
    }

    function _tax(address from, address to, uint256 amount) internal view returns (uint256, uint8) {
        if (feeExempt[from] || feeExempt[to] || pair == address(0)) return (0, 0);
        if (from == pair) {
            // Protocol-owned buys (executed via operatorCall/operatorBatchCall/depositBatch) bypass
            // the buy gate; it must only restrict ordinary users buying from the DEX.
            require(buyEnabled || inOperatorContext, "BUY_OFF");
            return ((amount * buyTaxBps) / BPS, 1);
        }
        if (to == pair) return ((amount * sellTaxBps) / BPS, 2);
        return (0, 0);
    }

    function _bind(address user, address nextReferrer) internal {
        if (referrer[user] != address(0)) return;
        require(nextReferrer != user, "SELF_REF");
        require(nextReferrer == root || referrer[nextReferrer] != address(0), "REF");
        referrer[user] = nextReferrer;
        emit RefBound(user, nextReferrer);
    }

    function _setOperator(address nextOperator) internal {
        require(nextOperator != address(0), "OPERATOR_ZERO");
        if (nextOperator == operator) return;
        if (operator != owner()) feeExempt[operator] = false;
        operator = nextOperator;
        feeExempt[nextOperator] = true;
    }

    function _validateProtocolConfig(ProtocolConfigInput calldata next) internal pure {
        require(next.operator != address(0), "OPERATOR_ZERO");
        require(next.buyTaxBps <= 2500 && next.sellTaxBps <= 2500, "TAX");
        require(next.minDeposit <= next.maxDeposit, "DEPOSIT");
        uint256 distributionTotal = uint256(next.lpBuildBps) + uint256(next.nodeBps)
            + uint256(next.builderBuyBps) + uint256(next.vaultBps) + uint256(next.directPoolBps);
        require(
            distributionTotal <= BPS && next.directRewardBps <= next.directPoolBps, "DISTRIBUTION"
        );
        require(next.settlementPeriodsPerDay != 0, "PERIODS");
        require(next.exitMultipleBps != 0, "EXIT");
        require(
            next.deflationHourlyBps <= next.deflationDailyCapBps
                && next.deflationDailyCapBps <= BPS,
            "DEFLATION"
        );
        require(
            uint256(next.buyTaxBuilderBps) + uint256(next.buyTaxVaultBps) <= next.buyTaxBps,
            "BUY_SPLIT"
        );
        require(
            uint256(next.sellTaxBuilderBps) + uint256(next.sellTaxOwnerBps)
                    + uint256(next.sellTaxVaultBps) <= next.sellTaxBps,
            "SELL_SPLIT"
        );
        for (uint256 index = 0; index < 10; ++index) {
            require(next.teamRewardBps[index] <= BPS, "TEAM");
        }
    }
}
