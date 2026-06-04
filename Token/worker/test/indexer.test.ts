import { describe, it, expect } from "vitest";
import {
  decodeProtocolLog,
  classifySystemLog,
  eventId,
  REF_BOUND_TOPIC,
  DEPOSIT_TOPIC,
  TAX_COLLECTED_TOPIC,
  NODE_UPDATED_TOPIC,
  type RawLog,
} from "../src/indexer";
import { BNB } from "../src/config";

function topicAddress(addr: string): string {
  return `0x${addr.replace(/^0x/, "").padStart(64, "0")}`;
}

const USER = "1111111111111111111111111111111111111111";
const REF = "2222222222222222222222222222222222222222";

describe("indexer decoding", () => {
  it("decodes RefBound and Deposit", () => {
    const refBound = decodeProtocolLog({
      blockNumber: 10n,
      blockHash: "0xblock",
      txHash: "0xABC",
      logIndex: 2,
      topics: [REF_BOUND_TOPIC, topicAddress(USER), topicAddress(REF)],
      data: "0x",
    })!;
    expect(eventId({ ...({} as RawLog), txHash: "0xABC", logIndex: 2 } as RawLog)).toBe("0xabc:2");
    expect(refBound.event.kind).toBe("RefBound");

    const deposit = decodeProtocolLog({
      blockNumber: 11n,
      blockHash: "0xblock2",
      txHash: "0xDEF",
      logIndex: 0,
      topics: [DEPOSIT_TOPIC, topicAddress(USER), topicAddress(REF)],
      data: `0x${BNB.toString(16).padStart(64, "0")}`,
    })!;
    expect(deposit.event.kind).toBe("Deposit");
    if (deposit.event.kind === "Deposit") {
      expect(deposit.event.amount).toBe(BNB);
      expect(deposit.event.user).toBe(`0x${USER}`);
    }
  });

  it("decodes TaxCollected (sell side)", () => {
    const tax = decodeProtocolLog({
      blockNumber: 12n,
      blockHash: "0xblock3",
      txHash: "0xF00",
      logIndex: 3,
      topics: [TAX_COLLECTED_TOPIC, topicAddress(USER), topicAddress(REF)],
      data: `0x${(3n * BNB).toString(16).padStart(64, "0")}${(2).toString(16).padStart(64, "0")}`,
    })!;
    expect(tax.event.kind).toBe("TaxCollected");
    if (tax.event.kind === "TaxCollected") {
      expect(tax.event.amount).toBe(3n * BNB);
      expect(tax.event.side).toBe("Sell");
    }
  });

  it("classifies NodeUpdated system log", () => {
    const sys = classifySystemLog({
      blockNumber: 5n,
      blockHash: "0xb",
      txHash: "0xNODE",
      logIndex: 0,
      topics: [NODE_UPDATED_TOPIC, topicAddress(USER)],
      data: `0x${(7).toString(16).padStart(64, "0")}`,
    });
    expect(sys?.kind).toBe("NodeUpdated");
    if (sys?.kind === "NodeUpdated") {
      expect(sys.weight).toBe(7);
      expect(sys.node).toBe(`0x${USER}`);
    }
  });
});
