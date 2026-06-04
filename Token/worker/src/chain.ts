/**
 * On-chain executor: build + sign + send BSC txs. Port of Token/offchain/src/chain.rs.
 * Uses viem for ABI encoding + signing; raw JSON-RPC over fetch for nonce/gasPrice/send/receipt.
 *
 * Invariant from the Rust original: every tx is sent with tx.value = 0. BNB movement is always
 * an argument to operatorCall(...)/execute(...), forwarded internally by the token/vault contract.
 */
import { encodeFunctionData, parseAbiItem, toFunctionSelector, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { OperatorCommand } from "./executor";

export const BPS_DENOMINATOR = 10_000n;
export const PANCAKE_V2_FEE_BPS = 9_975n; // BSC PancakeSwap default
export const QUICKSWAP_V2_FEE_BPS = 9_970n; // Polygon QuickSwap/Sushi default
export const MAX_BUY_TAX_BPS = 2_500;
export const GAS_LIMIT = 600_000n;
const RECEIPT_POLL_INTERVAL_MS = 3_000;
const RECEIPT_POLL_LIMIT = 120;
const U128_MAX = (1n << 128n) - 1n;

export interface ChainExecutionContext {
  tokenAddress: string;
  vaultAddress: string;
  routerAddress: string;
  ownerAddress: string;
  burnAddress: string;
  slippageBps: number;
  deadlineSeconds: number;
}

export class ChainError extends Error {}

interface PairReserves {
  tokenReserve: bigint;
  bnbReserve: bigint;
}

function normalizeAddress(value: string): Hex {
  const t = value.trim();
  if (!t.startsWith("0x") || !/^0x[0-9a-fA-F]{40}$/.test(t)) throw new ChainError("InvalidAddress");
  return t.toLowerCase() as Hex;
}

function u256ToU128(value: bigint): bigint {
  if (value > U128_MAX) throw new ChainError("InvalidAmount");
  return value;
}

/** chain.rs:1062 */
function quoteTokenAmount(bnbValue: bigint, r: PairReserves): bigint {
  if (bnbValue === 0n || r.bnbReserve === 0n || r.tokenReserve === 0n) throw new ChainError("InvalidAmount");
  return u256ToU128((bnbValue * r.tokenReserve) / r.bnbReserve);
}

/** chain.rs:1075 — constant product with configurable fee. */
function v2AmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feeBps: bigint): bigint {
  if (amountIn === 0n || reserveIn === 0n || reserveOut === 0n) throw new ChainError("InvalidAmount");
  const amountInWithFee = amountIn * feeBps;
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * BPS_DENOMINATOR + amountInWithFee;
  return u256ToU128(numerator / denominator);
}

/** chain.rs:1089 — saturating. */
function applySlippage(amount: bigint, slippageBps: number): bigint {
  if (slippageBps > 10_000) throw new ChainError("InvalidAmount");
  return (amount * BigInt(10_000 - slippageBps)) / BPS_DENOMINATOR;
}

function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

interface EvmCall {
  target: string;
  value: bigint;
  data: Hex;
}

// ABI item definitions for encodeFunctionData
const ABI = {
  operatorCall: parseAbiItem("function operatorCall(address target, uint256 value, bytes data)"),
  approve: parseAbiItem("function approve(address spender, uint256 amount)"),
  transfer: parseAbiItem("function transfer(address to, uint256 amount)"),
  burn: parseAbiItem("function burn(uint256 amount)"),
  pullPairTokens: parseAbiItem("function pullPairTokens(uint16 bps)"),
  operatorRedeemLp: parseAbiItem("function operatorRedeemLp(address user, uint256 lpAmount)"),
  addLiquidityETH: parseAbiItem(
    "function addLiquidityETH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline)",
  ),
  swapExactETHForTokens: parseAbiItem(
    "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline)",
  ),
  swapExactTokensForETH: parseAbiItem(
    "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
  ),
  execute: parseAbiItem("function execute(address target, uint256 value, bytes data)"),
  owner: parseAbiItem("function owner() view returns (address)"),
} as const;

const SELECTORS = {
  pair: toFunctionSelector("function pair() view returns (address)"),
  token0: toFunctionSelector("function token0() view returns (address)"),
  getReserves: toFunctionSelector(
    "function getReserves() view returns (uint112,uint112,uint32)",
  ),
  balanceOf: "function balanceOf(address) view returns (uint256)",
  totalSupply: toFunctionSelector("function totalSupply() view returns (uint256)"),
  weth: toFunctionSelector("function WETH() view returns (address)"),
} as const;

export class BscTransactionClient {
  private account: ReturnType<typeof privateKeyToAccount>;
  private token: Hex;
  private vault: Hex;
  private router: Hex;
  private burn: Hex;
  private feeBps: bigint;
  private feeDetected = false;

  constructor(
    private rpcUrl: string,
    private chainId: number,
    privateKey: Hex,
    private ctx: ChainExecutionContext,
    private confirmations: number = 1,
    /** Configured AMM fee numerator (kept-after-fee bps); used as fallback if auto-detect fails. */
    feeBps: number = 9975,
  ) {
    this.account = privateKeyToAccount(privateKey);
    this.token = normalizeAddress(ctx.tokenAddress);
    this.vault = normalizeAddress(ctx.vaultAddress);
    this.router = normalizeAddress(ctx.routerAddress);
    this.burn = normalizeAddress(ctx.burnAddress);
    this.feeBps = BigInt(feeBps);
  }

  /**
   * Best-effort AMM fee auto-detection. Many Uniswap V2 forks expose no fee getter
   * (fee is baked into the pair's swap math), so we probe a few known non-standard
   * methods and fall back to the configured fee. Runs once, lazily, before swaps.
   */
  private async detectFee(): Promise<void> {
    if (this.feeDetected) return;
    this.feeDetected = true;
    try {
      const pair = await this.pairAddress();
      // Some forks expose swapFee() / kSwap() returning the fee taken (in bps or per-mille).
      for (const sel of ["function swapFee() view returns (uint256)"]) {
        try {
          const data = toFunctionSelector(sel);
          const out = await this.ethCall(pair, data);
          const raw = this.parseU128Word(out, 0);
          // Interpret common encodings: e.g. 25 => 0.25% (bps of fee) → keep 9975.
          if (raw > 0n && raw < 1000n) {
            this.feeBps = BPS_DENOMINATOR - raw;
            return;
          }
        } catch {
          // method not present on this fork; ignore
        }
      }
    } catch {
      // pair not ready / probe failed → keep configured fee
    }
  }

  walletAddress(): Hex {
    return this.account.address.toLowerCase() as Hex;
  }

  // ---- raw RPC ----
  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!res.ok) throw new ChainError(`http ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new ChainError(body.error.message);
    if (body.result === undefined || body.result === null) throw new ChainError("MissingResult");
    return body.result;
  }

  private async ethCall(target: string, data: Hex): Promise<Hex> {
    return this.rpc<Hex>("eth_call", [{ to: normalizeAddress(target), data }, "latest"]);
  }

  private wordAt(value: string, index: number): string {
    const hex = value.slice(2);
    return hex.slice(index * 64, index * 64 + 64);
  }

  private parseU128Word(value: string, index: number): bigint {
    const word = this.wordAt(value, index);
    if (word.length !== 64) throw new ChainError("InvalidAmount");
    if (/[^0]/.test(word.slice(0, 32))) throw new ChainError("InvalidAmount");
    return BigInt(`0x${word.slice(32)}`);
  }

  private parseAddressWord(value: string): Hex {
    const hex = value.slice(2);
    if (hex.length < 64) throw new ChainError("InvalidHex");
    return normalizeAddress(`0x${hex.slice(24, 64)}`);
  }

  private async pairAddress(): Promise<Hex> {
    const pair = this.parseAddressWord(await this.ethCall(this.token, SELECTORS.pair));
    if (pair === "0x0000000000000000000000000000000000000000") {
      throw new ChainError("pair is not initialized");
    }
    return pair;
  }

  private async pairReserves(): Promise<PairReserves> {
    const pair = await this.pairAddress();
    const token0 = this.parseAddressWord(await this.ethCall(pair, SELECTORS.token0));
    const reserves = await this.ethCall(pair, SELECTORS.getReserves);
    const reserve0 = this.parseU128Word(reserves, 0);
    const reserve1 = this.parseU128Word(reserves, 1);
    return token0 === this.token
      ? { tokenReserve: reserve0, bnbReserve: reserve1 }
      : { tokenReserve: reserve1, bnbReserve: reserve0 };
  }

  private async erc20BalanceOf(token: string, account: string): Promise<bigint> {
    const data = encodeFunctionData({
      abi: [parseAbiItem(SELECTORS.balanceOf)],
      functionName: "balanceOf",
      args: [normalizeAddress(account)],
    });
    return this.parseU128Word(await this.ethCall(token, data), 0);
  }

  private async pairTotalSupply(pair: string): Promise<bigint> {
    return this.parseU128Word(await this.ethCall(pair, SELECTORS.totalSupply), 0);
  }

  private async wethAddress(): Promise<Hex> {
    return this.parseAddressWord(await this.ethCall(this.router, SELECTORS.weth));
  }

  private deadline(): bigint {
    return nowSeconds() + BigInt(this.ctx.deadlineSeconds);
  }

  // ---- encoders (viem matches the hand-rolled Rust ABI output) ----
  private encodeOperatorCall(target: string, value: bigint, data: Hex): Hex {
    return encodeFunctionData({
      abi: [ABI.operatorCall],
      functionName: "operatorCall",
      args: [normalizeAddress(target), value, data],
    });
  }

  // ---- tx submit ----
  private async submitEvmCall(call: EvmCall): Promise<string> {
    const target = normalizeAddress(call.target);
    const [nonceHex, gasPriceHex] = await Promise.all([
      this.rpc<string>("eth_getTransactionCount", [this.walletAddress(), "pending"]),
      this.rpc<string>("eth_gasPrice", []),
    ]);
    const signed = await this.account.signTransaction!({
      chainId: this.chainId,
      type: "legacy",
      to: target,
      value: call.value,
      data: call.data,
      nonce: Number(BigInt(nonceHex)),
      gas: GAS_LIMIT,
      gasPrice: BigInt(gasPriceHex),
    });
    const txHash = await this.rpc<string>("eth_sendRawTransaction", [signed]);
    await this.waitForConfirmedReceipt(txHash, BigInt(Math.max(1, this.confirmations)));
    return txHash;
  }

  private async waitForConfirmedReceipt(txHash: string, confirmations: bigint): Promise<void> {
    for (let i = 0; i < RECEIPT_POLL_LIMIT; i++) {
      const receipt = await this.rpc<{ status: string; blockNumber: string } | null>(
        "eth_getTransactionReceipt",
        [txHash],
      ).catch(() => null);
      if (receipt) {
        if (receipt.status !== "0x1") throw new ChainError(`ReceiptFailed: ${txHash}`);
        const receiptBlock = BigInt(receipt.blockNumber);
        const target = receiptBlock + (confirmations - 1n);
        const head = BigInt(await this.rpc<string>("eth_blockNumber", []));
        if (head >= target) return;
      }
      await new Promise((r) => setTimeout(r, RECEIPT_POLL_INTERVAL_MS));
    }
    throw new ChainError(`ReceiptTimeout: ${txHash}`);
  }

  /** token.operatorCall(target, value, data) — outer tx value always 0 (chain.rs:523). */
  private async submitOperatorCall(target: string, value: bigint, data: Hex): Promise<string> {
    return this.submitEvmCall({
      target: this.token,
      value: 0n,
      data: this.encodeOperatorCall(target, value, data),
    });
  }

  // ---- per-command handlers ----

  private async submitPlatformTokenBuy(bnbAmount: bigint): Promise<[string, bigint]> {
    if (bnbAmount === 0n) throw new ChainError("InvalidAmount");
    await this.detectFee();
    const reserves = await this.pairReserves();
    const tokenOut = v2AmountOut(bnbAmount, reserves.bnbReserve, reserves.tokenReserve, this.feeBps);
    const amountOutMin = applySlippage(tokenOut, this.ctx.slippageBps);
    const weth = await this.wethAddress();
    const operator = this.walletAddress();
    const before = await this.erc20BalanceOf(this.token, operator);
    const swap = encodeFunctionData({
      abi: [ABI.swapExactETHForTokens],
      functionName: "swapExactETHForTokensSupportingFeeOnTransferTokens",
      args: [amountOutMin, [weth, this.token], operator, this.deadline()],
    });
    const swapHash = await this.submitOperatorCall(this.router, bnbAmount, swap);
    const after = await this.erc20BalanceOf(this.token, operator);
    const received = after - before;
    if (received <= 0n) throw new ChainError("InvalidAmount");
    const transfer = encodeFunctionData({
      abi: [ABI.transfer],
      functionName: "transfer",
      args: [this.token, received],
    });
    // direct ERC20 transfer from operator wallet to token contract
    const transferHash = await this.submitEvmCall({ target: this.token, value: 0n, data: transfer });
    return [`${swapHash},${transferHash}`, received];
  }

  private async submitAddLiquidity(bnbAmount: bigint, tokenValueBnb: bigint): Promise<string> {
    if (bnbAmount === 0n || tokenValueBnb === 0n) throw new ChainError("InvalidAmount");
    const [buyHashes, tokenAmount] = await this.submitPlatformTokenBuy(tokenValueBnb);
    const bnbMin = applySlippage(bnbAmount, this.ctx.slippageBps);
    const postBuy = await this.pairReserves();
    const routerTokenAmount = quoteTokenAmount(bnbAmount, postBuy);
    const tokenMin = applySlippage(
      routerTokenAmount < tokenAmount ? routerTokenAmount : tokenAmount,
      this.ctx.slippageBps,
    );
    const approve = encodeFunctionData({
      abi: [ABI.approve],
      functionName: "approve",
      args: [this.router, tokenAmount],
    });
    const approveHash = await this.submitOperatorCall(this.token, 0n, approve);
    const addLiquidity = encodeFunctionData({
      abi: [ABI.addLiquidityETH],
      functionName: "addLiquidityETH",
      args: [this.token, tokenAmount, tokenMin, bnbMin, this.token, this.deadline()],
    });
    const liquidityHash = await this.submitOperatorCall(this.router, bnbAmount, addLiquidity);
    return `${buyHashes},${approveHash},${liquidityHash}`;
  }

  private async submitBuyback(bnbAmount: bigint): Promise<string> {
    await this.detectFee();
    const reserves = await this.pairReserves();
    const tokenOut = v2AmountOut(bnbAmount, reserves.bnbReserve, reserves.tokenReserve, this.feeBps);
    const minAfterSlippage = applySlippage(tokenOut, this.ctx.slippageBps);
    const amountOutMin = applySlippage(minAfterSlippage, MAX_BUY_TAX_BPS);
    const weth = await this.wethAddress();
    const swap = encodeFunctionData({
      abi: [ABI.swapExactETHForTokens],
      functionName: "swapExactETHForTokensSupportingFeeOnTransferTokens",
      args: [amountOutMin, [weth, this.token], this.burn, this.deadline()],
    });
    const vaultExecute = encodeFunctionData({
      abi: [ABI.execute],
      functionName: "execute",
      args: [this.router, bnbAmount, swap],
    });
    return this.submitOperatorCall(this.vault, 0n, vaultExecute);
  }

  private async submitRewardToken(to: string, amount: bigint): Promise<string> {
    const reserves = await this.pairReserves();
    const tokenAmount = quoteTokenAmount(amount, reserves);
    const transfer = encodeFunctionData({
      abi: [ABI.transfer],
      functionName: "transfer",
      args: [normalizeAddress(to), tokenAmount],
    });
    return this.submitOperatorCall(this.token, 0n, transfer);
  }

  private async submitBurnTokenByBnbValue(amount: bigint): Promise<string> {
    const reserves = await this.pairReserves();
    const burnAmount = quoteTokenAmount(amount, reserves);
    const burn = encodeFunctionData({ abi: [ABI.burn], functionName: "burn", args: [burnAmount] });
    return this.submitOperatorCall(this.token, 0n, burn);
  }

  private async submitSweepTaxToBnb(
    taxTokenAmount: bigint,
    builderTokenAmount: bigint,
    burnTokenAmount: bigint,
    ownerBnbBpsOfSold: number,
    vaultBnbBpsOfSold: number,
  ): Promise<string> {
    if (
      taxTokenAmount === 0n ||
      builderTokenAmount + burnTokenAmount > taxTokenAmount ||
      ownerBnbBpsOfSold + vaultBnbBpsOfSold > 10_000
    ) {
      throw new ChainError("InvalidAmount");
    }
    const sellAmount = taxTokenAmount - builderTokenAmount - burnTokenAmount;
    const hashes: string[] = [];

    if (burnTokenAmount !== 0n) {
      const burn = encodeFunctionData({ abi: [ABI.burn], functionName: "burn", args: [burnTokenAmount] });
      hashes.push(await this.submitOperatorCall(this.token, 0n, burn));
    }

    if (sellAmount !== 0n) {
      const approve = encodeFunctionData({
        abi: [ABI.approve],
        functionName: "approve",
        args: [this.router, sellAmount],
      });
      hashes.push(await this.submitOperatorCall(this.token, 0n, approve));

      const reserves = await this.pairReserves();
      const bnbOut = v2AmountOut(sellAmount, reserves.tokenReserve, reserves.bnbReserve, this.feeBps);
      const amountOutMin = applySlippage(bnbOut, this.ctx.slippageBps);
      const weth = await this.wethAddress();
      const swap = encodeFunctionData({
        abi: [ABI.swapExactTokensForETH],
        functionName: "swapExactTokensForETHSupportingFeeOnTransferTokens",
        args: [sellAmount, amountOutMin, [this.token, weth], this.token, this.deadline()],
      });
      hashes.push(await this.submitOperatorCall(this.router, 0n, swap));

      const ownerAmt = (bnbOut * BigInt(ownerBnbBpsOfSold)) / BPS_DENOMINATOR;
      const vaultAmt = (bnbOut * BigInt(vaultBnbBpsOfSold)) / BPS_DENOMINATOR;
      if (ownerAmt !== 0n) {
        const fwd = this.encodeOperatorCall(this.ctx.ownerAddress, ownerAmt, "0x");
        hashes.push(await this.submitOperatorCall(this.token, 0n, fwd));
      }
      if (vaultAmt !== 0n) {
        const fwd = this.encodeOperatorCall(this.vault, vaultAmt, "0x");
        hashes.push(await this.submitOperatorCall(this.token, 0n, fwd));
      }
    }
    return hashes.join(",");
  }

  private async submitRedeemUserLp(
    user: string,
    lpBnbShare: bigint,
    totalActivePrincipal: bigint,
  ): Promise<string> {
    if (lpBnbShare === 0n || totalActivePrincipal === 0n) throw new ChainError("InvalidAmount");
    if (lpBnbShare > totalActivePrincipal) {
      throw new ChainError("lp share exceeds active principal denominator");
    }
    const pair = await this.pairAddress();
    const pairBalance = await this.erc20BalanceOf(pair, this.token);
    if (pairBalance === 0n) throw new ChainError("token contract has no LP custody");
    const pairTotalSupply = await this.pairTotalSupply(pair);
    const reserves = await this.pairReserves();
    if (pairTotalSupply === 0n || reserves.bnbReserve === 0n) throw new ChainError("InvalidAmount");

    let lpToRemove = u256ToU128((pairBalance * lpBnbShare) / totalActivePrincipal);
    if (lpToRemove > pairBalance) lpToRemove = pairBalance;
    if (lpToRemove === 0n) throw new ChainError("InvalidAmount");

    const expectedBnbOut = u256ToU128((lpToRemove * reserves.bnbReserve) / pairTotalSupply);
    if (expectedBnbOut === 0n) throw new ChainError("pair BNB reserve would return zero refund");
    const floor = lpBnbShare / 2n;
    if (expectedBnbOut < floor) {
      throw new ChainError(`LP_RESERVE_INSUFFICIENT: expected_bnb_out=${expectedBnbOut} < floor=${floor}`);
    }
    const redeem = encodeFunctionData({
      abi: [ABI.operatorRedeemLp],
      functionName: "operatorRedeemLp",
      args: [normalizeAddress(user), lpToRemove],
    });
    return this.submitEvmCall({ target: this.token, value: 0n, data: redeem });
  }

  private encodeCommandCall(command: OperatorCommand): EvmCall {
    switch (command.kind) {
      case "TransferBnb":
        return { target: this.token, value: 0n, data: this.encodeOperatorCall(command.to, command.amount, "0x") };
      case "CreditVault":
        return { target: this.token, value: 0n, data: this.encodeOperatorCall(this.vault, command.amount, "0x") };
      case "PullPairTokens":
        return {
          target: this.token,
          value: 0n,
          data: encodeFunctionData({
            abi: [ABI.pullPairTokens],
            functionName: "pullPairTokens",
            args: [command.bps],
          }),
        };
      default:
        throw new ChainError(`Unsupported direct command: ${command.kind}`);
    }
  }

  /** chain.rs:715 dispatch. */
  async submit(command: OperatorCommand): Promise<string> {
    switch (command.kind) {
      case "AddLiquidity":
        return this.submitAddLiquidity(command.bnbAmount, command.tokenValueBnb);
      case "BuilderBuy":
        return (await this.submitPlatformTokenBuy(command.bnbAmount))[0];
      case "Buyback":
        return this.submitBuyback(command.bnbAmount);
      case "PayRewardTokenByBnbValue":
        return this.submitRewardToken(command.to, command.amount);
      case "BurnTokenByBnbValue":
        return this.submitBurnTokenByBnbValue(command.amount);
      case "RedeemUserLp":
        return this.submitRedeemUserLp(command.user, command.lpBnbShare, command.totalActivePrincipal);
      case "SweepTaxToBnb":
        return this.submitSweepTaxToBnb(
          command.taxTokenAmount,
          command.builderTokenAmount,
          command.burnTokenAmount,
          command.ownerBnbBpsOfSold,
          command.vaultBnbBpsOfSold,
        );
      case "ExitPosition":
        throw new ChainError("legacy exit-position is replaced by separate burn/refund commands");
      case "TransferBnb":
      case "CreditVault":
      case "PullPairTokens":
        return this.submitEvmCall(this.encodeCommandCall(command));
    }
  }
}
