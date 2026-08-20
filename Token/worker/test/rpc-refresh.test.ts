import { describe, expect, it } from "vitest";
import { rpcSnapshotIsFresh } from "../src/rpc-refresh";

describe("RPC snapshot TTL", () => {
  it("refreshes an empty, expired, or clock-skewed snapshot", () => {
    expect(rpcSnapshotIsFresh(0, 30, 100_000)).toBe(false);
    expect(rpcSnapshotIsFresh(70_000, 30, 100_000)).toBe(false);
    expect(rpcSnapshotIsFresh(110_000, 30, 100_000)).toBe(false);
  });

  it("keeps a successful snapshot only inside the configured TTL", () => {
    expect(rpcSnapshotIsFresh(70_001, 30, 100_000)).toBe(true);
    expect(rpcSnapshotIsFresh(99_999, 30, 100_000)).toBe(true);
    expect(rpcSnapshotIsFresh(70_000, 0, 100_000)).toBe(false);
  });
});
