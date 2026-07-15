import { afterEach, describe, expect, it, vi } from "vitest";
import { BscTransactionClient, reconciliationBlockRanges, type ChainExecutionContext } from "../src/chain";

const context: ChainExecutionContext = {
  tokenAddress: "0x1111111111111111111111111111111111111111",
  vaultAddress: "0x2222222222222222222222222222222222222222",
  routerAddress: "0x3333333333333333333333333333333333333333",
  ownerAddress: "0x4444444444444444444444444444444444444444",
  burnAddress: "0x000000000000000000000000000000000000dead",
  indexerStartBlock: 1n,
  slippageBps: 100,
  deadlineSeconds: 300,
};

afterEach(() => vi.unstubAllGlobals());

describe("chain reconciliation ranges", () => {
  it("splits inclusive block scans below the provider limit without gaps", () => {
    expect(reconciliationBlockRanges(100n, 219n, 40n)).toEqual([
      { fromBlock: 100n, toBlock: 139n },
      { fromBlock: 140n, toBlock: 179n },
      { fromBlock: 180n, toBlock: 219n },
    ]);
  });

  it("handles a final partial range and an empty range", () => {
    expect(reconciliationBlockRanges(100n, 181n, 40n)).toEqual([
      { fromBlock: 100n, toBlock: 139n },
      { fromBlock: 140n, toBlock: 179n },
      { fromBlock: 180n, toBlock: 181n },
    ]);
    expect(reconciliationBlockRanges(2n, 1n, 40n)).toEqual([]);
  });

  it("rejects a non-positive maximum range", () => {
    expect(() => reconciliationBlockRanges(1n, 2n, 0n)).toThrow("InvalidBlockRange");
  });

  it("starts redemption reconciliation at the confirmed anchor and queries bounded ranges", async () => {
    const logFilters: Array<{ fromBlock: string; toBlock: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as { method: string; params: unknown[] };
      let result: unknown;
      if (request.method === "eth_getTransactionReceipt") {
        result = { status: "0x1", blockNumber: "0x64" };
      } else if (request.method === "eth_blockNumber") {
        result = "0x138e3"; // 80,099: exactly two 40,000-block ranges from block 100.
      } else if (request.method === "eth_getLogs") {
        const filter = request.params[0] as { fromBlock: string; toBlock: string };
        logFilters.push({ fromBlock: filter.fromBlock, toBlock: filter.toBlock });
        result = [];
      } else {
        throw new Error(`unexpected RPC method ${request.method}`);
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        headers: { "content-type": "application/json" },
      });
    }));

    const client = new BscTransactionClient(
      "https://rpc.invalid",
      56,
      `0x${"1".repeat(64)}`,
      context,
      1,
    );
    const found = await client.findConfirmedCommand(
      "static:user:slot:2:redeem-user-lp",
      {
        kind: "RedeemUserLp",
        user: "0x5555555555555555555555555555555555555555",
        lpTokenAmount: 123n,
      },
      `0x${"a".repeat(64)}`,
    );

    expect(found).toBe(null);
    expect(logFilters).toEqual([
      { fromBlock: "0x64", toBlock: "0x9ca3" },
      { fromBlock: "0x9ca4", toBlock: "0x138e3" },
    ]);
    expect(logFilters.every(({ fromBlock, toBlock }) => BigInt(toBlock) - BigInt(fromBlock) + 1n <= 40_000n)).toBe(true);
  });
});
