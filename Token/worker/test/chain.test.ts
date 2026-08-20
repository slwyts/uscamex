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

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

  it("retries a rate-limited transaction preparation read", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let receiptCalls = 0;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as { method: string };
      if (request.method === "eth_getTransactionReceipt") {
        receiptCalls += 1;
        if (receiptCalls === 1) return new Response("rate limited", { status: 429 });
        return Response.json({ jsonrpc: "2.0", id: 1, result: { status: "0x1", blockNumber: "0x64" } });
      }
      if (request.method === "eth_blockNumber") {
        return Response.json({ jsonrpc: "2.0", id: 1, result: "0x64" });
      }
      if (request.method === "eth_getLogs") {
        return Response.json({ jsonrpc: "2.0", id: 1, result: [] });
      }
      throw new Error(`unexpected RPC method ${request.method}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new BscTransactionClient(
      "https://rpc.invalid",
      56,
      `0x${"1".repeat(64)}`,
      context,
      1,
    );
    const result = client.findConfirmedCommand(
      "static:user:slot:2:redeem-user-lp",
      {
        kind: "RedeemUserLp",
        user: "0x5555555555555555555555555555555555555555",
        lpTokenAmount: 123n,
      },
      `0x${"a".repeat(64)}`,
    );
    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe(null);
    expect(receiptCalls).toBe(2);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('"method":"eth_getTransactionReceipt"'));
  });

  it("does not retry raw transaction broadcasts", async () => {
    const fetchMock = vi.fn(async () => new Response("rate limited", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new BscTransactionClient(
      "https://rpc.invalid",
      56,
      `0x${"1".repeat(64)}`,
      context,
      1,
    ) as unknown as { rpc<T>(method: string, params: unknown[]): Promise<T> };

    await expect(client.rpc("eth_sendRawTransaction", ["0x01"])).rejects.toThrow("http 429");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the configured fallback after primary receipt reads stay rate limited", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      if (String(url) === "https://primary.invalid") return new Response("rate limited", { status: 429 });
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: { status: "0x1", blockNumber: "0x64" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new BscTransactionClient(
      "https://primary.invalid",
      56,
      `0x${"1".repeat(64)}`,
      context,
      1,
      9975,
      "https://fallback.invalid",
    ) as unknown as { waitForConfirmedReceipt(txHash: string, confirmations: bigint): Promise<void> };

    const result = client.waitForConfirmedReceipt(`0x${"a".repeat(64)}`, 1n);
    await vi.runAllTimersAsync();

    await expect(result).resolves.toBeUndefined();
    expect(urls).toEqual([
      "https://primary.invalid",
      "https://primary.invalid",
      "https://primary.invalid",
      "https://fallback.invalid",
    ]);
  });

  it("does not use the fallback for the pending transaction nonce", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response("rate limited", { status: 429 });
    }));
    const client = new BscTransactionClient(
      "https://primary.invalid",
      56,
      `0x${"1".repeat(64)}`,
      context,
      1,
      9975,
      "https://fallback.invalid",
    ) as unknown as { rpc<T>(method: string, params: unknown[]): Promise<T> };

    const result = client.rpc("eth_getTransactionCount", ["0x1111111111111111111111111111111111111111", "pending"]);
    const rejection = expect(result).rejects.toThrow("http 429");
    await vi.runAllTimersAsync();

    await rejection;
    expect(urls).toEqual([
      "https://primary.invalid",
      "https://primary.invalid",
      "https://primary.invalid",
    ]);
  });

  it("stops receipt polling after repeated read failures", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () => new Response("rate limited", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new BscTransactionClient(
      "https://rpc.invalid",
      56,
      `0x${"1".repeat(64)}`,
      context,
      1,
    ) as unknown as { waitForConfirmedReceipt(txHash: string, confirmations: bigint): Promise<void> };

    const result = client.waitForConfirmedReceipt(`0x${"a".repeat(64)}`, 1n);
    const rejection = expect(result).rejects.toThrow("ReceiptLookupFailed");
    await vi.runAllTimersAsync();

    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(9);
  });
});

describe("submitted transaction status", () => {
  function client(): BscTransactionClient {
    return new BscTransactionClient(
      "https://rpc.invalid",
      56,
      `0x${"1".repeat(64)}`,
      context,
      1,
    );
  }

  it("reports a missing transaction as dropped when the account has no pending nonce", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as { method: string; params: unknown[] };
      const result = request.method === "eth_getTransactionCount"
        ? "0x2a"
        : request.method === "eth_getTransactionReceipt" || request.method === "eth_getTransactionByHash"
          ? null
          : undefined;
      if (result === undefined) throw new Error(`unexpected RPC method ${request.method}`);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        headers: { "content-type": "application/json" },
      });
    }));

    await expect(client().submittedTransactionStatus(`0x${"a".repeat(64)}`)).resolves.toBe("dropped");
  });

  it("propagates receipt RPC errors instead of reporting a false pending status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: "upstream unavailable" },
    }), { headers: { "content-type": "application/json" } })));

    await expect(client().submittedTransactionStatus(`0x${"a".repeat(64)}`)).rejects.toThrow("upstream unavailable");
  });

  it("uses the read-only fallback when the primary receipt RPC is rate limited", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init: RequestInit) => {
      urls.push(String(url));
      if (String(url) === "https://primary.invalid") return new Response("rate limited", { status: 429 });
      const request = JSON.parse(String(init.body)) as { method: string };
      if (request.method !== "eth_getTransactionReceipt") {
        throw new Error(`unexpected fallback RPC method ${request.method}`);
      }
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { status: "0x1", blockNumber: "0x2a" },
      }), { headers: { "content-type": "application/json" } });
    }));
    const fallbackClient = new BscTransactionClient(
      "https://primary.invalid",
      56,
      `0x${"1".repeat(64)}`,
      context,
      1,
      9975,
      "https://fallback.invalid",
    );

    await expect(fallbackClient.submittedTransactionStatus(`0x${"a".repeat(64)}`)).resolves.toBe("confirmed");
    expect(urls).toEqual(["https://primary.invalid", "https://fallback.invalid"]);
  });

  it("uses a confirmed fallback receipt when the primary still reports the transaction as pending", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as { method: string };
      calls.push({ url: String(url), method: request.method });
      const result = String(url) === "https://primary.invalid"
        ? request.method === "eth_getTransactionReceipt"
          ? null
          : request.method === "eth_getTransactionByHash"
            ? { hash: `0x${"a".repeat(64)}` }
            : undefined
        : request.method === "eth_getTransactionReceipt"
          ? { status: "0x1", blockNumber: "0x2a" }
          : undefined;
      if (result === undefined) throw new Error(`unexpected RPC method ${request.method}`);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        headers: { "content-type": "application/json" },
      });
    }));
    const fallbackClient = new BscTransactionClient(
      "https://primary.invalid",
      56,
      `0x${"1".repeat(64)}`,
      context,
      1,
      9975,
      "https://fallback.invalid",
    );

    await expect(fallbackClient.submittedTransactionStatus(`0x${"a".repeat(64)}`)).resolves.toBe("confirmed");
    expect(calls).toEqual([
      { url: "https://primary.invalid", method: "eth_getTransactionReceipt" },
      { url: "https://primary.invalid", method: "eth_getTransactionByHash" },
      { url: "https://fallback.invalid", method: "eth_getTransactionReceipt" },
    ]);
  });
});
