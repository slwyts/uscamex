import { describe, it, expect } from "vitest";
import {
  BNB,
  bps,
  defaultProtocolConfig,
  formatBnbAmount,
  parseBnbAmount,
  validateConfig,
} from "../src/config";

describe("config helpers", () => {
  it("bps computes amount * rate / 10000", () => {
    expect(bps(BNB, 80)).toBe((BNB * 80n) / 10_000n);
  });

  it("parse/format bnb roundtrips", () => {
    expect(parseBnbAmount("1.5")).toBe(BNB + BNB / 2n);
    expect(formatBnbAmount(BNB + BNB / 2n)).toBe("1.5");
    expect(formatBnbAmount(BNB)).toBe("1");
  });

  it("default config is valid", () => {
    expect(() => validateConfig(defaultProtocolConfig())).not.toThrow();
  });

  it("rejects min > max", () => {
    const c = defaultProtocolConfig();
    c.minDeposit = c.maxDeposit + 1n;
    expect(() => validateConfig(c)).toThrow();
  });
});
