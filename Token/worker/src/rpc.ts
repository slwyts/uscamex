/**
 * BSC JSON-RPC read client. Port of Token/offchain/src/rpc.rs.
 * Uses fetch() to the operator RPC URL. ABI word parsing is manual (matching rpc.rs word_at/parse_* helpers)
 * to preserve exact decoding semantics, including the getProtocolConfig() word index map.
 */
import { keccak256, toHex } from "viem";
import { defaultProtocolConfig, validateConfig, type ProtocolConfig } from "./config";
import { ALL_TOPICS, type RawLog } from "./indexer";

export const OWNER_SELECTOR = "0x8da5cb5b"; // owner()
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface PairReserves {
  pair: string;
  tokenReserve: bigint;
  bnbReserve: bigint;
}

export interface ChainProtocolConfig {
  operator: string;
  buyEnabled: boolean;
  config: ProtocolConfig;
}

export class RpcError extends Error {}

function functionSelector(signature: string): string {
  return keccak256(toHex(signature)).slice(0, 10); // 0x + 8 hex = 4 bytes
}

function hexQuantity(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function u256Word(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function parseHexBig(value: string): bigint {
  return BigInt(value);
}

function normalizeAddress(value: string): string {
  const t = value.trim();
  if (!t.startsWith("0x")) throw new RpcError("InvalidAddress");
  const hex = t.slice(2);
  if (hex.length !== 40 || !/^[0-9a-fA-F]{40}$/.test(hex)) throw new RpcError("InvalidAddress");
  return `0x${hex.toLowerCase()}`;
}

function wordAt(value: string, index: number): string {
  const t = value.trim();
  if (!t.startsWith("0x")) throw new RpcError("InvalidHex");
  const hex = t.slice(2);
  const start = index * 64;
  const word = hex.slice(start, start + 64);
  if (word.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(word)) throw new RpcError("InvalidHex");
  return word;
}

function parseU128Word(value: string, index: number): bigint {
  const word = wordAt(value, index);
  if (/[^0]/.test(word.slice(0, 32))) throw new RpcError("InvalidHex");
  return BigInt(`0x${word.slice(32)}`);
}

function parseNumWord(value: string, index: number, max: bigint): number {
  const v = parseU128Word(value, index);
  if (v > max) throw new RpcError("InvalidHex");
  return Number(v);
}

function parseBoolWord(value: string, index: number): boolean {
  const v = parseU128Word(value, index);
  if (v === 0n) return false;
  if (v === 1n) return true;
  throw new RpcError("InvalidHex");
}

function parseAddressWord(value: string): string {
  const t = value.trim();
  if (!t.startsWith("0x")) throw new RpcError("InvalidHex");
  const hex = t.slice(2);
  if (hex.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(hex)) throw new RpcError("InvalidHex");
  return normalizeAddress(`0x${hex.slice(24)}`);
}

function parseAddressWordAt(value: string, index: number): string {
  return normalizeAddress(`0x${wordAt(value, index).slice(24)}`);
}

interface RpcLogJson {
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  logIndex: string;
  topics: string[];
  data: string;
  removed?: boolean;
}

export class BscRpcClient {
  private tokenAddress: string;
  private vaultCache: string | null = null;
  private pairCache: string | null = null;

  constructor(
    private rpcUrl: string,
    tokenAddress: string,
  ) {
    this.tokenAddress = normalizeAddress(tokenAddress);
  }

  getTokenAddress(): string {
    return this.tokenAddress;
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!res.ok) throw new RpcError(`http ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new RpcError(body.error.message);
    if (body.result === undefined || body.result === null) throw new RpcError("MissingResult");
    return body.result;
  }

  private async ethCall(data: string): Promise<string> {
    return this.ethCallTo(this.tokenAddress, data);
  }

  private async ethCallTo(target: string, data: string): Promise<string> {
    return this.rpc<string>("eth_call", [{ to: normalizeAddress(target), data }, "latest"]);
  }

  async owner(): Promise<string> {
    return parseAddressWord(await this.ethCall(OWNER_SELECTOR));
  }

  async vault(): Promise<string> {
    if (this.vaultCache) return this.vaultCache;
    const vault = parseAddressWord(await this.ethCall(functionSelector("vault()")));
    this.vaultCache = vault;
    return vault;
  }

  async pair(): Promise<string> {
    if (this.pairCache) return this.pairCache;
    const pair = parseAddressWord(await this.ethCall(functionSelector("pair()")));
    if (pair !== ZERO_ADDRESS) this.pairCache = pair;
    return pair;
  }

  /** getProtocolConfig() — word index map is identical to rpc.rs:135-160. */
  async protocolConfig(): Promise<ChainProtocolConfig> {
    const out = await this.ethCall(functionSelector("getProtocolConfig()"));
    const U16 = 0xffffn;
    const U8 = 0xffn;
    const U32 = 0xffffffffn;

    const teamRewardBps: number[] = [];
    for (let i = 0; i < 10; i++) teamRewardBps.push(parseNumWord(out, 15 + i, U16));

    const config: ProtocolConfig = {
      ...defaultProtocolConfig(),
      minDeposit: parseU128Word(out, 3),
      maxDeposit: parseU128Word(out, 4),
      lpBuildBps: parseNumWord(out, 6, U16),
      nodeBps: parseNumWord(out, 7, U16),
      builderBuyBps: parseNumWord(out, 8, U16),
      vaultBps: parseNumWord(out, 9, U16),
      directPoolBps: parseNumWord(out, 10, U16),
      directRewardBps: parseNumWord(out, 11, U16),
      dailyStaticBps: parseNumWord(out, 12, U16),
      settlementPeriodsPerDay: parseNumWord(out, 13, U8),
      exitMultipleBps: parseNumWord(out, 14, U32),
      teamRewardBps,
      deflationEnabled: parseBoolWord(out, 25),
      deflationHourlyBps: parseNumWord(out, 26, U16),
      deflationDailyCapBps: parseNumWord(out, 27, U16),
      buybackEnabled: parseBoolWord(out, 28),
      buybackPerMinute: parseU128Word(out, 29),
      buyTaxBps: parseNumWord(out, 1, U16),
      buyTaxBuilderBps: parseNumWord(out, 30, U16),
      buyTaxVaultBps: parseNumWord(out, 31, U16),
      sellTaxBps: parseNumWord(out, 2, U16),
      sellTaxBuilderBps: parseNumWord(out, 32, U16),
      sellTaxOwnerBps: parseNumWord(out, 33, U16),
      sellTaxVaultBps: parseNumWord(out, 34, U16),
      bindCost: parseU128Word(out, 35),
    };
    try {
      validateConfig(config);
    } catch (e) {
      throw new RpcError(`invalid protocol config: ${(e as Error).message}`);
    }
    return {
      operator: parseAddressWordAt(out, 0),
      buyEnabled: parseBoolWord(out, 5),
      config,
    };
  }

  async nodes(): Promise<{ address: string; weight: number }[]> {
    const countOut = await this.ethCall(functionSelector("nodeCount()"));
    const count = Number(parseU128Word(countOut, 0));
    const nodes: { address: string; weight: number }[] = [];
    for (let i = 0; i < count; i++) {
      const data = functionSelector("nodeAt(uint256)") + u256Word(BigInt(i));
      const out = await this.ethCall(data);
      const address = parseAddressWordAt(out, 0);
      const weight = parseNumWord(out, 1, 0xffffffffn);
      if (weight !== 0) nodes.push({ address, weight });
    }
    return nodes;
  }

  async pairReserves(): Promise<PairReserves | null> {
    const pair = await this.pair();
    if (pair === ZERO_ADDRESS) return null;
    const token0 = parseAddressWord(await this.ethCallTo(pair, functionSelector("token0()")));
    const reserves = await this.ethCallTo(pair, functionSelector("getReserves()"));
    const reserve0 = parseU128Word(reserves, 0);
    const reserve1 = parseU128Word(reserves, 1);
    const [tokenReserve, bnbReserve] =
      token0 === this.tokenAddress ? [reserve0, reserve1] : [reserve1, reserve0];
    return { pair, tokenReserve, bnbReserve };
  }

  async nativeBalance(address: string): Promise<bigint> {
    const result = await this.rpc<string>("eth_getBalance", [normalizeAddress(address), "latest"]);
    return parseHexBig(result);
  }

  async tokenBalance(address: string): Promise<bigint> {
    const data = functionSelector("balanceOf(address)") + u256Word(BigInt(normalizeAddress(address)));
    const result = await this.ethCall(data);
    return parseU128Word(result, 0);
  }

  async blockNumber(): Promise<bigint> {
    return parseHexBig(await this.rpc<string>("eth_blockNumber", []));
  }

  async blockHash(blockNumber: bigint): Promise<string> {
    const block = await this.rpc<{ hash: string } | null>("eth_getBlockByNumber", [
      hexQuantity(blockNumber),
      false,
    ]);
    if (!block) throw new RpcError("MissingResult");
    return block.hash.toLowerCase();
  }

  async protocolLogs(fromBlock: bigint, toBlock: bigint): Promise<RawLog[]> {
    const filter = {
      address: this.tokenAddress,
      fromBlock: hexQuantity(fromBlock),
      toBlock: hexQuantity(toBlock),
      topics: [ALL_TOPICS],
    };
    const logs = await this.rpc<RpcLogJson[]>("eth_getLogs", [filter]);
    return logs
      .filter((log) => !log.removed)
      .map((log) => ({
        blockNumber: parseHexBig(log.blockNumber),
        blockHash: log.blockHash.toLowerCase(),
        txHash: log.transactionHash.toLowerCase(),
        logIndex: Number(parseHexBig(log.logIndex)),
        topics: log.topics.map((t) => t.toLowerCase()),
        data: log.data,
      }));
  }
}
