import { afterEach, describe, expect, it, vi } from "vitest";
import { BscRpcClient } from "../src/rpc";

const TOKEN = "0x1111111111111111111111111111111111111111";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("BSC read RPC retry", () => {
  it("backs off after a 429 and returns the next successful result", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: "0x2a",
      }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = new BscRpcClient("https://rpc.invalid", TOKEN).blockNumber();
    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe(42n);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('"status":429'));
  });

  it("does not retry a non-transient HTTP error", async () => {
    const fetchMock = vi.fn(async () => new Response("bad request", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new BscRpcClient("https://rpc.invalid", TOKEN).blockNumber()).rejects.toThrow("http 400");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
