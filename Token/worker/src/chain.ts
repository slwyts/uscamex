/**
 * On-chain executor: build + sign + send BSC txs. Port of Token/offchain/src/chain.rs.
 * Uses viem for ABI encoding + signing; raw JSON-RPC over fetch for nonce/gasPrice/send/receipt.
 *
 * Invariant from the Rust original: every tx is sent with tx.value = 0. BNB movement is always
 * an argument to operatorCall(...)/execute(...), forwarded internally by the token/vault contract.
 */
import { encodeFunctionData, keccak256, parseAbiItem, toFunctionSelector, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { OperatorCommand } from "./executor";

export const BPS_DENOMINATOR = 10_000n;
export const PANCAKE_V2_FEE_BPS = 9_975n; // BSC PancakeSwap default
export const QUICKSWAP_V2_FEE_BPS = 9_970n; // Polygon QuickSwap/Sushi default
export const MAX_BUY_TAX_BPS = 2_500;
export const GAS_LIMIT = 600_000n;
const RECEIPT_POLL_INTERVAL_MS = 2_000;
const RECEIPT_POLL_LIMIT = 60;
const GAS_PRICE_BUMP_BPS = [12_000n, 20_000n, 40_000n, 80_000n];
const U128_MAX = (1n << 128n) - 1n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const DEPOSIT_BATCH_EXECUTED_TOPIC = keccak256(
  toHex("DepositBatchExecuted(address,uint256,uint256,uint256,uint256,uint256,address,uint256,uint256)"),
);
const LP_REDEEMED_TOPIC = keccak256(toHex("LpRedeemed(address,uint256,uint256,uint256)"));

export interface ChainExecutionContext {
  tokenAddress: string;
  vaultAddress: string;
  routerAddress: string;
  ownerAddress: string;
  burnAddress: string;
  indexerStartBlock: bigint;
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

function addressTopic(value: string): Hex {
  return `0x${normalizeAddress(value).slice(2).padStart(64, "0")}` as Hex;
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

function gasPriceForAttempt(base: bigint, attempt: number): bigint {
  const factor = GAS_PRICE_BUMP_BPS[Math.min(attempt, GAS_PRICE_BUMP_BPS.length - 1)];
  return (base * factor) / BPS_DENOMINATOR + 1n;
}

function errorMessage(err: unknown): string {
  return String((err as Error).message ?? err);
}

function isReplacementUnderpriced(err: unknown): boolean {
  return errorMessage(err).toLowerCase().includes("replacement transaction underpriced");
}

function isAlreadyKnown(err: unknown): boolean {
  const msg = errorMessage(err).toLowerCase();
  return msg.includes("already known") || msg.includes("known transaction");
}

interface EvmCall {
  target: string;
  value: bigint;
  data: Hex;
}

interface RpcReceiptJson {
  status: string;
  blockNumber: string;
}

interface RpcLogJson {
  transactionHash: string;
  topics: string[];
  data: string;
  removed?: boolean;
}

export interface DepositBatchExecution {
  txHash: string;
  lpBnb: bigint;
  lpTokenValueBnb: bigint;
  lpMinted: bigint;
  builderBnb: bigint;
  vaultBnb: bigint;
  directReferrer: string | null;
  directBnb: bigint;
  nodeBnb: bigint;
}

// ABI item definitions for encodeFunctionData
const ABI = {
  operatorCall: parseAbiItem("function operatorCall(address target, uint256 value, bytes data)"),
  operatorBatchCall: parseAbiItem("function operatorBatchCall(address[] targets, uint256[] values, bytes[] datas)"),
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

const ABI_DEPOSIT_BATCH = parseAbiItem(
  "function depositBatch((address user,uint128 amount,uint128 lpBnb,uint128 lpTokenValueBnb,uint128 minLpTokenOut,uint128 builderBnb,uint128 minBuilderTokenOut,uint128 vaultBnb,address directReferrer,uint128 directBnb,(address to,uint128 amount)[] nodePayouts) params)",
);

const SELECTORS = {
  pair: toFunctionSelector("function pair() view returns (address)"),
  token0: toFunctionSelector("function token0() view returns (address)"),
  getReserves: toFunctionSelector(
    "function getReserves() view returns (uint112,uint112,uint32)",
  ),
  balanceOf: "function balanceOf(address) view returns (uint256)",
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

  private parseTopicAddress(topic: string): Hex {
    if (!/^0x[0-9a-fA-F]{64}$/.test(topic)) throw new ChainError("InvalidHex");
    return normalizeAddress(`0x${topic.slice(26)}`);
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

  private encodeOperatorBatchCall(targets: string[], values: bigint[], datas: Hex[]): Hex {
    if (targets.length === 0 || targets.length !== values.length || targets.length !== datas.length) {
      throw new ChainError("InvalidBatch");
    }
    return encodeFunctionData({
      abi: [ABI.operatorBatchCall],
      functionName: "operatorBatchCall",
      args: [targets.map(normalizeAddress), values, datas],
    });
  }

  // ---- tx submit ----
  private async submitEvmCall(call: EvmCall): Promise<string> {
    const target = normalizeAddress(call.target);
    const [nonceHex, gasPriceHex] = await Promise.all([
      this.rpc<string>("eth_getTransactionCount", [this.walletAddress(), "pending"]),
      this.rpc<string>("eth_gasPrice", []),
    ]);
    const nonce = Number(BigInt(nonceHex));
    const baseGasPrice = BigInt(gasPriceHex);
    let lastErr: unknown = null;

    for (let attempt = 0; attempt < GAS_PRICE_BUMP_BPS.length; attempt += 1) {
      const signed = await this.account.signTransaction!({
        chainId: this.chainId,
        type: "legacy",
        to: target,
        value: call.value,
        data: call.data,
        nonce,
        gas: GAS_LIMIT,
        gasPrice: gasPriceForAttempt(baseGasPrice, attempt),
      });
      const signedTxHash = keccak256(signed);
      try {
        const txHash = await this.rpc<string>("eth_sendRawTransaction", [signed]);
        await this.waitForConfirmedReceipt(txHash, BigInt(Math.max(1, this.confirmations)));
        return txHash;
      } catch (err) {
        lastErr = err;
        if (isAlreadyKnown(err)) {
          await this.waitForConfirmedReceipt(signedTxHash, BigInt(Math.max(1, this.confirmations)));
          return signedTxHash;
        }
        if (isReplacementUnderpriced(err) && attempt + 1 < GAS_PRICE_BUMP_BPS.length) continue;
        throw err;
      }
    }

    throw lastErr instanceof Error ? lastErr : new ChainError(errorMessage(lastErr));
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

  private async submitDepositBatch(b: {
    user: string;
    amount: bigint;
    lpBnb: bigint;
    lpTokenValueBnb: bigint;
    builderBnb: bigint;
    vaultBnb: bigint;
    directReferrer: string | null;
    directBnb: bigint;
    nodePayouts: { to: string; amount: bigint }[];
  }): Promise<string> {
    await this.detectFee();
    const reserves = await this.pairReserves();
    let projectedReserves = reserves;
    let minLpTokenOut = 0n;
    if (this.lpAmountsValid(b.lpBnb, b.lpTokenValueBnb)) {
      const buyOut = v2AmountOut(b.lpTokenValueBnb, reserves.bnbReserve, reserves.tokenReserve, this.feeBps);
      minLpTokenOut = applySlippage(buyOut, this.ctx.slippageBps);
      if (minLpTokenOut === 0n) throw new ChainError("InvalidAmount");

      const postBuy = {
        bnbReserve: reserves.bnbReserve + b.lpTokenValueBnb,
        tokenReserve: reserves.tokenReserve - buyOut,
      };
      const tokenForLp = quoteTokenAmount(b.lpBnb, postBuy);
      const tokenConsumed = tokenForLp < buyOut ? tokenForLp : buyOut;
      projectedReserves = {
        bnbReserve: postBuy.bnbReserve + b.lpBnb,
        tokenReserve: postBuy.tokenReserve + tokenConsumed,
      };
    }

    let minBuilderTokenOut = 0n;
    if (b.builderBnb !== 0n) {
      const builderOut = v2AmountOut(
        b.builderBnb,
        projectedReserves.bnbReserve,
        projectedReserves.tokenReserve,
        this.feeBps,
      );
      minBuilderTokenOut = applySlippage(builderOut, this.ctx.slippageBps);
      if (minBuilderTokenOut === 0n) throw new ChainError("InvalidAmount");
    }

    const nodePayouts = b.nodePayouts
      .filter((payout) => payout.amount !== 0n)
      .map((payout) => ({ to: normalizeAddress(payout.to), amount: u256ToU128(payout.amount) }));
    const directReferrer =
      b.directReferrer != null && b.directBnb !== 0n
        ? normalizeAddress(b.directReferrer)
        : "0x0000000000000000000000000000000000000000";
    const hasWork =
      b.lpBnb !== 0n ||
      b.lpTokenValueBnb !== 0n ||
      b.builderBnb !== 0n ||
      b.vaultBnb !== 0n ||
      b.directBnb !== 0n ||
      nodePayouts.length !== 0;
    if (!hasWork) throw new ChainError("InvalidAmount");

    const data = encodeFunctionData({
      abi: [ABI_DEPOSIT_BATCH],
      functionName: "depositBatch",
      args: [
        {
          user: normalizeAddress(b.user),
          amount: u256ToU128(b.amount),
          lpBnb: u256ToU128(b.lpBnb),
          lpTokenValueBnb: u256ToU128(b.lpTokenValueBnb),
          minLpTokenOut,
          builderBnb: u256ToU128(b.builderBnb),
          minBuilderTokenOut,
          vaultBnb: u256ToU128(b.vaultBnb),
          directReferrer,
          directBnb: u256ToU128(b.directBnb),
          nodePayouts,
        },
      ],
    });
    return this.submitEvmCall({ target: this.token, value: 0n, data });
  }

  async findConfirmedCommand(id: string, command: OperatorCommand): Promise<string | null> {
    if (command.kind === "DepositBatch") return this.findConfirmedDepositBatch(id, command);
    if (command.kind === "RedeemUserLp") return this.findConfirmedRedeemUserLp(command);
    return null;
  }

  private async findConfirmedDepositBatch(
    id: string,
    command: Extract<OperatorCommand, { kind: "DepositBatch" }>,
  ): Promise<string | null> {
    const depositTxHash = this.depositTxHashFromJournalId(id);
    if (!depositTxHash) return null;
    const depositReceipt = await this.rpc<RpcReceiptJson | null>("eth_getTransactionReceipt", [depositTxHash])
      .catch(() => null);
    if (!depositReceipt || depositReceipt.status !== "0x1") return null;

    const logs = await this.rpc<RpcLogJson[]>("eth_getLogs", [
      {
        address: this.token,
        fromBlock: depositReceipt.blockNumber,
        toBlock: "latest",
        topics: [DEPOSIT_BATCH_EXECUTED_TOPIC],
      },
    ]);
    for (const log of logs) {
      if (log.removed || !this.depositBatchLogMatches(log, command)) continue;
      return log.transactionHash.toLowerCase();
    }
    for (const log of logs) {
      if (log.removed || !this.depositBatchLogRecoveryMatches(log, command)) continue;
      return log.transactionHash.toLowerCase();
    }
    return null;
  }

  private depositTxHashFromJournalId(id: string): Hex | null {
    const match = /^deposit:(0x[0-9a-fA-F]{64}):\d+:\d+:deposit-batch$/.exec(id);
    return match ? (match[1].toLowerCase() as Hex) : null;
  }

  private depositBatchLogMatches(
    log: RpcLogJson,
    command: Extract<OperatorCommand, { kind: "DepositBatch" }>,
  ): boolean {
    if (log.topics[0]?.toLowerCase() !== DEPOSIT_BATCH_EXECUTED_TOPIC) return false;
    if (this.parseTopicAddress(log.topics[1]) !== normalizeAddress(command.user)) return false;
    const directReferrer =
      command.directReferrer != null && command.directBnb !== 0n
        ? normalizeAddress(command.directReferrer)
        : ZERO_ADDRESS;
    const nodeBnb = command.nodePayouts.reduce((sum, payout) => sum + payout.amount, 0n);
    try {
      return (
        this.parseTopicAddress(log.topics[2]) === directReferrer &&
        this.parseU128Word(log.data, 0) === command.lpBnb &&
        this.parseU128Word(log.data, 1) === command.lpTokenValueBnb &&
        this.parseU128Word(log.data, 3) === command.builderBnb &&
        this.parseU128Word(log.data, 4) === command.vaultBnb &&
        this.parseU128Word(log.data, 5) === command.directBnb &&
        this.parseU128Word(log.data, 6) === nodeBnb
      );
    } catch {
      return false;
    }
  }

  private depositBatchLogRecoveryMatches(
    log: RpcLogJson,
    command: Extract<OperatorCommand, { kind: "DepositBatch" }>,
  ): boolean {
    if (log.topics[0]?.toLowerCase() !== DEPOSIT_BATCH_EXECUTED_TOPIC) return false;
    if (this.parseTopicAddress(log.topics[1]) !== normalizeAddress(command.user)) return false;
    const nodeBnb = command.nodePayouts.reduce((sum, payout) => sum + payout.amount, 0n);
    try {
      const eventVaultBnb = this.parseU128Word(log.data, 4);
      const eventDirectBnb = this.parseU128Word(log.data, 5);
      return (
        this.parseU128Word(log.data, 0) === command.lpBnb &&
        this.parseU128Word(log.data, 1) === command.lpTokenValueBnb &&
        this.parseU128Word(log.data, 3) === command.builderBnb &&
        this.parseU128Word(log.data, 6) === nodeBnb &&
        eventVaultBnb + eventDirectBnb === command.vaultBnb + command.directBnb
      );
    } catch {
      return false;
    }
  }

  async depositBatchExecution(
    txHash: string,
    command: Extract<OperatorCommand, { kind: "DepositBatch" }>,
  ): Promise<DepositBatchExecution | null> {
    const receipt = await this.rpc<RpcReceiptJson | null>("eth_getTransactionReceipt", [txHash]).catch(() => null);
    if (!receipt || receipt.status !== "0x1") return null;
    const logs = await this.rpc<RpcLogJson[]>("eth_getLogs", [
      {
        address: this.token,
        fromBlock: receipt.blockNumber,
        toBlock: receipt.blockNumber,
        topics: [DEPOSIT_BATCH_EXECUTED_TOPIC],
      },
    ]);
    for (const log of logs) {
      if (
        log.removed ||
        (!this.depositBatchLogMatches(log, command) &&
          !this.depositBatchLogRecoveryMatches(log, command))
      ) {
        continue;
      }
      const directReferrer = this.parseTopicAddress(log.topics[2]);
      return {
        txHash: log.transactionHash.toLowerCase(),
        lpBnb: this.parseU128Word(log.data, 0),
        lpTokenValueBnb: this.parseU128Word(log.data, 1),
        lpMinted: this.parseU128Word(log.data, 2),
        builderBnb: this.parseU128Word(log.data, 3),
        vaultBnb: this.parseU128Word(log.data, 4),
        directReferrer: directReferrer === ZERO_ADDRESS ? null : directReferrer,
        directBnb: this.parseU128Word(log.data, 5),
        nodeBnb: this.parseU128Word(log.data, 6),
      };
    }
    return null;
  }

  private async findConfirmedRedeemUserLp(
    command: Extract<OperatorCommand, { kind: "RedeemUserLp" }>,
  ): Promise<string | null> {
    const logs = await this.rpc<RpcLogJson[]>("eth_getLogs", [
      {
        address: this.token,
        fromBlock: `0x${this.ctx.indexerStartBlock.toString(16)}`,
        toBlock: "latest",
        topics: [LP_REDEEMED_TOPIC, addressTopic(command.user)],
      },
    ]);
    for (const log of logs) {
      if (log.removed) continue;
      try {
        if (this.parseU128Word(log.data, 0) === command.lpTokenAmount) {
          return log.transactionHash.toLowerCase();
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  private lpAmountsValid(lpBnb: bigint, lpTokenValueBnb: bigint): boolean {
    if (lpBnb === 0n && lpTokenValueBnb === 0n) return false;
    if (lpBnb === 0n || lpTokenValueBnb === 0n) throw new ChainError("InvalidAmount");
    return true;
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
    const targets: string[] = [];
    const values: bigint[] = [];
    const datas: Hex[] = [];

    if (burnTokenAmount !== 0n) {
      const burn = encodeFunctionData({ abi: [ABI.burn], functionName: "burn", args: [burnTokenAmount] });
      targets.push(this.token);
      values.push(0n);
      datas.push(burn);
    }

    if (sellAmount !== 0n) {
      const approve = encodeFunctionData({
        abi: [ABI.approve],
        functionName: "approve",
        args: [this.router, sellAmount],
      });
      targets.push(this.token);
      values.push(0n);
      datas.push(approve);

      const reserves = await this.pairReserves();
      const bnbOut = v2AmountOut(sellAmount, reserves.tokenReserve, reserves.bnbReserve, this.feeBps);
      const amountOutMin = applySlippage(bnbOut, this.ctx.slippageBps);
      const weth = await this.wethAddress();
      const vaultOnly = ownerBnbBpsOfSold === 0 && vaultBnbBpsOfSold === 10_000;
      const swapRecipient = vaultOnly ? this.vault : this.token;
      const swap = encodeFunctionData({
        abi: [ABI.swapExactTokensForETH],
        functionName: "swapExactTokensForETHSupportingFeeOnTransferTokens",
        args: [sellAmount, amountOutMin, [this.token, weth], swapRecipient, this.deadline()],
      });
      targets.push(this.router);
      values.push(0n);
      datas.push(swap);

      if (!vaultOnly) {
        const ownerAmt = (amountOutMin * BigInt(ownerBnbBpsOfSold)) / BPS_DENOMINATOR;
        const vaultAmt = (amountOutMin * BigInt(vaultBnbBpsOfSold)) / BPS_DENOMINATOR;
        if (ownerAmt !== 0n) {
          targets.push(this.ctx.ownerAddress);
          values.push(ownerAmt);
          datas.push("0x");
        }
        if (vaultAmt !== 0n) {
          targets.push(this.vault);
          values.push(vaultAmt);
          datas.push("0x");
        }
      }
    }
    return this.submitEvmCall({
      target: this.token,
      value: 0n,
      data: this.encodeOperatorBatchCall(targets, values, datas),
    });
  }

  private async submitRedeemUserLp(user: string, lpTokenAmount: bigint): Promise<string> {
    if (lpTokenAmount === 0n) throw new ChainError("InvalidAmount");
    const pair = await this.pairAddress();
    const lpCustody = await this.erc20BalanceOf(pair, this.token);
    if (lpTokenAmount > lpCustody) throw new ChainError("token contract has insufficient LP custody");
    const redeem = encodeFunctionData({
      abi: [ABI.operatorRedeemLp],
      functionName: "operatorRedeemLp",
      args: [normalizeAddress(user), u256ToU128(lpTokenAmount)],
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
        return this.submitRedeemUserLp(command.user, command.lpTokenAmount);
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
      case "DepositBatch":
        return this.submitDepositBatch({
          lpBnb: command.lpBnb,
          user: command.user,
          amount: command.amount,
          lpTokenValueBnb: command.lpTokenValueBnb,
          builderBnb: command.builderBnb,
          vaultBnb: command.vaultBnb,
          directReferrer: command.directReferrer,
          directBnb: command.directBnb,
          nodePayouts: command.nodePayouts,
        });
    }
  }
}
