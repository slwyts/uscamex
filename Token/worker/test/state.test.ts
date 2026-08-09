import { describe, expect, it } from "vitest";
import { ProtocolState, serializeState, serializeStateForStorage } from "../src/state";

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

describe("state storage snapshot", () => {
  it("keeps growing idempotency history out of the Durable Object state value", () => {
    const state = new ProtocolState("root");
    for (let i = 0; i < 30_000; i += 1) {
      const address = i.toString(16).padStart(40, "0");
      state.processedSettlements.add(`static:0x${address}:2026-08-08T06:00+08/4`);
    }
    state.processedEvents.add("0xtx:1");
    state.appliedDepositBatches.add("deposit:0xtx:1");

    expect(serializedBytes(serializeState(state))).toBeGreaterThan(2 * 1024 * 1024);

    const stored = serializeStateForStorage(state);
    expect(stored.processedEvents).toEqual([]);
    expect(stored.processedSettlements).toEqual([]);
    expect(stored.appliedDepositBatches).toEqual([]);
    expect(serializedBytes(stored)).toBeLessThan(8 * 1024);
  });
});
