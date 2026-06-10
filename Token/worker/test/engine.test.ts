import { describe, it, expect } from "vitest";
import { BNB, bps, defaultProtocolConfig, type ProtocolConfig } from "../src/config";
import { Engine } from "../src/engine";
import { ProtocolState } from "../src/state";

function engine(overrides: Partial<ProtocolConfig> = {}): Engine {
  return new Engine({ ...defaultProtocolConfig(), ...overrides });
}

describe("engine: binding (zero-transfer model)", () => {
  it("adopts on-chain binds unconditionally, even out of order", () => {
    const e = engine();
    const s = new ProtocolState("root");
    // downline event arrives BEFORE its upline's event in the same batch
    expect(e.adoptChainBind(s, "carol", "bob")).toBe(true);
    expect(s.user("carol")!.referrer).toBe("bob");
    expect(s.user("bob")!.directCount).toBe(1);
    // upline event arrives later; carol must stay bound, bob now binds alice
    expect(e.adoptChainBind(s, "bob", "alice")).toBe(true);
    expect(s.user("bob")!.referrer).toBe("alice");
    // re-adopting an already-bound user is a no-op
    expect(e.adoptChainBind(s, "carol", "bob")).toBe(false);
    expect(s.user("bob")!.directCount).toBe(1);
  });
});

describe("engine: deposit", () => {
  it("allocates bnb by origin rules", () => {
    const e = engine();
    const s = new ProtocolState("root");
    s.nodes.push({ address: "node-a", weight: 1 });
    s.nodes.push({ address: "node-b", weight: 1 });
    e.bind(s, "alice", "root");

    const a = e.deposit(s, "alice", BNB);
    expect(a.lpBnb).toBe((3n * BNB) / 10n);
    expect(a.lpTokenValueBnb).toBe((3n * BNB) / 10n);
    expect(a.nodeBnb).toBe(BNB / 10n);
    expect(a.nodePayouts.length).toBe(2);
    expect(a.builderBnb).toBe(BNB / 10n);
    expect(a.vaultBnb).toBe(BNB / 10n);
    expect(a.directBnb).toBe(BNB / 10n);
    expect(s.balances.nodePaidBnb.get("node-a")).toBe(BNB / 20n);
    expect(s.balances.directPaidBnb.get("root")).toBe(BNB / 10n);
    expect(s.pair.bnbReserve).toBe((7n * BNB) / 10n);
    expect(s.user("alice")!.lpBnbPrincipal).toBe((3n * BNB) / 10n);
  });

  it("pays the full direct reward that triggers dynamic exit", () => {
    const e = engine({ exitMultipleBps: 10_000 });
    const s = new ProtocolState("root");
    e.bind(s, "alice", "root");
    e.deposit(s, "alice", BNB);
    e.bind(s, "bob", "alice");
    s.ensureUserMut("alice").staticPaidBnb = BNB - 1n;
    s.ensureUserMut("alice").lpTokenPrincipal = 123n;

    const a = e.deposit(s, "bob", BNB);
    expect(a.directBnb).toBe(BNB / 10n);
    expect(a.vaultBnb).toBe(BNB / 10n);
    expect(s.user("alice")!.dynamicPaidBnb).toBe(BNB / 10n);
    expect(s.user("alice")!.exited).toBe(true);
    expect(a.lpRedeems.length).toBe(1);
    expect(a.lpRedeems[0].user).toBe("alice");
    expect(a.lpRedeems[0].lpTokenAmount).toBe(123n);
    expect(s.balances.totalActiveLpPrincipalBnb).toBe((3n * BNB) / 10n);
  });

  it("pays direct reward to a bound-but-never-invested upline", () => {
    const e = engine();
    const s = new ProtocolState("root");
    e.bind(s, "alice", "root");
    e.bind(s, "bob", "alice");

    const a = e.deposit(s, "bob", BNB);
    expect(a.directBnb).toBe(BNB / 10n);
    expect(a.vaultBnb).toBe(BNB / 10n);
    expect(s.balances.directPaidBnb.get("alice")).toBe(BNB / 10n);
    expect(s.user("alice")!.dynamicPaidBnb).toBe(0n);
  });

  it("pays direct reward to root upline even though root has no principal", () => {
    const e = engine();
    const s = new ProtocolState("root");
    e.bind(s, "alice", "root");

    // root (project wallet) is always eligible for the direct reward
    const a = e.deposit(s, "alice", BNB);
    expect(a.directBnb).toBe(BNB / 10n);
    expect(a.vaultBnb).toBe(BNB / 10n);
    expect(s.balances.directPaidBnb.get("root")).toBe(BNB / 10n);
  });

  it("pays direct reward to an exited referrer without changing inactive dynamic income", () => {
    const e = engine();
    const s = new ProtocolState("root");
    e.bind(s, "alice", "root");
    e.deposit(s, "alice", BNB);
    e.withdrawLp(s, "alice");
    e.bind(s, "bob", "alice");

    const a = e.deposit(s, "bob", BNB);
    expect(a.directBnb).toBe(BNB / 10n);
    expect(a.vaultBnb).toBe(BNB / 10n);
    expect(s.balances.directPaidBnb.get("alice")).toBe(BNB / 10n);
    expect(s.user("alice")!.dynamicPaidBnb).toBe(0n);
  });

  it("exited user re-enters with fresh position accounting", () => {
    const e = engine({ dailyStaticBps: 10_000, exitMultipleBps: 10_000 });
    const s = new ProtocolState("root");
    e.bind(s, "alice", "root");
    e.deposit(s, "alice", BNB);
    s.ensureUserMut("alice").lpTokenPrincipal = 123n;
    for (let i = 0; i < 4; i++) e.settleStaticPeriod(s, "alice");
    expect(s.user("alice")!.exited).toBe(true);
    expect(s.user("alice")!.positionId).toBe(0n);

    e.deposit(s, "alice", BNB);
    const acct = s.user("alice")!;
    expect(acct.positionId).toBe(1n);
    expect(acct.principalBnb).toBe(BNB);
    expect(acct.staticPaidBnb).toBe(0n);
    expect(acct.dynamicPaidBnb).toBe(0n);
    expect(acct.active).toBe(true);
    expect(acct.exited).toBe(false);
  });
});

describe("engine: static settlement", () => {
  it("pays the full static period reward that triggers exit", () => {
    const e = engine({ dailyStaticBps: 10_000, exitMultipleBps: 10_000 });
    const s = new ProtocolState("root");
    e.bind(s, "alice", "root");
    e.deposit(s, "alice", BNB);
    s.ensureUserMut("alice").staticPaidBnb = BNB - 1n;
    s.ensureUserMut("alice").lpTokenPrincipal = 123n;

    const settlement = e.settleStaticPeriod(s, "alice");
    expect(settlement.staticBnb).toBe(BNB / 4n);
    expect(s.user("alice")!.staticPaidBnb).toBe(BNB - 1n + BNB / 4n);
    expect(s.user("alice")!.exited).toBe(true);
    expect(settlement.lpRedeems[0]).toEqual({ user: "alice", lpTokenAmount: 123n });
  });

  it("pays team and exits at cap", () => {
    const e = engine({ dailyStaticBps: 10_000, directRewardBps: 0, exitMultipleBps: 10_000 });
    const s = new ProtocolState("root");
    e.bind(s, "alice", "root");
    e.bind(s, "bob", "alice");
    e.deposit(s, "alice", BNB);
    e.deposit(s, "bob", BNB);
    s.ensureUserMut("bob").lpTokenPrincipal = 456n;

    const settlement = e.settleStaticPeriod(s, "bob");
    expect(settlement.staticBnb).toBe(BNB / 4n);
    expect(settlement.teamRewards[0].user).toBe("alice");
    expect(settlement.teamRewards[0].amount).toBe(BNB / 40n);
    expect(settlement.exitRefundBnb).toBe(null);

    for (let i = 0; i < 3; i++) e.settleStaticPeriod(s, "bob");
    expect(s.user("bob")!.exited).toBe(true);
  });

  it("ten generation rewards obey invested-direct-count gates", () => {
    const e = engine({ dailyStaticBps: 10_000, exitMultipleBps: 1_000_000 });
    const s = new ProtocolState("root");
    let previous = "root";
    for (let index = 1; index <= 10; index++) {
      const user = `u${index}`;
      e.bind(s, user, previous);
      e.deposit(s, user, BNB);
      previous = user;
    }
    e.bind(s, "leaf", "u10");
    e.deposit(s, "leaf", BNB);
    // Each ancestor uN needs investedDirectCount >= generation. Generation k maps
    // to ancestor u(11-k), which must have k invested directs. The main chain
    // already gives each uN one invested direct (its chain child), so add
    // (generation-1) MORE directs that actually deposit (bound-only must NOT count).
    for (let generation = 1; generation <= 10; generation++) {
      const ancestor = `u${11 - generation}`;
      for (let extra = 1; extra < generation; extra++) {
        const child = `${ancestor}-inv-${extra}`;
        e.bind(s, child, ancestor);
        e.deposit(s, child, BNB);
      }
      // a bound-only child that never invests must not unlock a generation
      e.bind(s, `${ancestor}-boundonly`, ancestor);
    }

    const settlement = e.settleStaticPeriod(s, "leaf");
    expect(settlement.teamRewards.length).toBe(10);
    settlement.teamRewards.forEach((reward, index) => {
      expect(reward.generation).toBe(index + 1);
      expect(reward.user).toBe(`u${10 - index}`);
      expect(reward.amount).toBe(bps(BNB / 4n, e.config.teamRewardBps[index]));
    });
  });

  it("bound-only directs do not unlock team generations", () => {
    const e = engine({ dailyStaticBps: 10_000, exitMultipleBps: 1_000_000 });
    const s = new ProtocolState("root");
    e.bind(s, "alice", "root");
    e.deposit(s, "alice", BNB);
    e.bind(s, "bob", "alice");
    e.deposit(s, "bob", BNB);
    // carol binds to alice but never deposits -> alice.investedDirectCount stays 1
    e.bind(s, "carol", "alice");

    expect(s.user("alice")!.directCount).toBe(2);
    expect(s.user("alice")!.investedDirectCount).toBe(1);

    // bob settles: alice is gen-1 upline, needs investedDirectCount >= 1 -> ok
    const settlement = e.settleStaticPeriod(s, "bob");
    expect(settlement.teamRewards.length).toBe(1);
    expect(settlement.teamRewards[0].user).toBe("alice");
  });

  it("period key prevents duplicate rewards", () => {
    const e = engine({ dailyStaticBps: 10_000, exitMultipleBps: 1_000_000 });
    const s = new ProtocolState("root");
    e.bind(s, "alice", "root");
    e.deposit(s, "alice", BNB);

    expect(e.settleStaticPeriodOnce(s, "alice", "period-1")).not.toBe(null);
    expect(s.user("alice")!.staticPaidBnb).toBe(BNB / 4n);
    expect(e.settleStaticPeriodOnce(s, "alice", "period-1")).toBe(null);
    expect(s.user("alice")!.staticPaidBnb).toBe(BNB / 4n);
    expect(e.settleStaticPeriodOnce(s, "alice", "period-2")).not.toBe(null);
    expect(s.user("alice")!.staticPaidBnb).toBe(BNB / 2n);
  });
});

describe("engine: deflation + buyback + tax", () => {
  it("deflation and buyback move pair reserves", () => {
    const e = engine();
    const s = new ProtocolState("root");
    s.pair.tokenReserve = 1_000_000n * BNB;
    s.pair.bnbReserve = 100n * BNB;
    s.balances.vaultBnb = BNB / 5n;

    expect(e.applyDeflation(s, 0n)).toBe(1_000n * BNB);
    expect(s.deflationUsedBps).toBe(10);

    const burned = e.buybackTick(s);
    expect(burned > 0n).toBe(true);
    expect(s.balances.vaultBnb).toBe(BNB / 10n);
    expect(s.balances.burnedTokens).toBe(burned);
  });

  it("skips buyback when vault balance is below the configured per-minute target", () => {
    const e = engine({ buybackPerMinute: BNB / 10n });
    const s = new ProtocolState("root");
    s.pair.tokenReserve = 1_000_000n * BNB;
    s.pair.bnbReserve = 100n * BNB;
    s.balances.vaultBnb = BNB / 10n - 1n;

    expect(e.buybackTick(s)).toBe(0n);
    expect(s.balances.vaultBnb).toBe(BNB / 10n - 1n);
    expect(s.balances.burnedTokens).toBe(0n);
  });

  it("deflation respects daily cap, disable, and day reset", () => {
    const e = engine({ deflationHourlyBps: 150, deflationDailyCapBps: 200 });
    const s = new ProtocolState("root");
    s.pair.tokenReserve = 1_000_000n * BNB;

    expect(e.applyDeflation(s, 0n) > 0n).toBe(true);
    expect(s.deflationUsedBps).toBe(150);
    expect(e.applyDeflation(s, 0n) > 0n).toBe(true);
    expect(s.deflationUsedBps).toBe(200);
    expect(e.applyDeflation(s, 0n)).toBe(0n);
    expect(e.applyDeflation(s, 1n) > 0n).toBe(true);
    expect(s.deflationUsedBps).toBe(150);
  });

  it("trade tax allocation matches origin rules", () => {
    const e = engine();
    const s = new ProtocolState("root");
    const buy = e.applyTradeTax(s, "Buy", BNB);
    expect(buy.totalTaxBnb).toBe((3n * BNB) / 100n);
    expect(buy.builderTokenValueBnb).toBe(BNB / 100n);
    expect(buy.vaultBnb).toBe((2n * BNB) / 100n);
    expect(buy.ownerBnb).toBe(0n);

    const sell = e.applyTradeTax(s, "Sell", BNB);
    expect(sell.totalTaxBnb).toBe(BNB / 10n);
    expect(sell.builderTokenValueBnb).toBe((3n * BNB) / 100n);
    expect(sell.ownerBnb).toBe((3n * BNB) / 100n);
    expect(sell.vaultBnb).toBe((4n * BNB) / 100n);
    expect(s.balances.builderTokenValueBnb).toBe((4n * BNB) / 100n);
    expect(s.balances.ownerBnb).toBe((3n * BNB) / 100n);
    expect(s.balances.vaultBnb).toBe((6n * BNB) / 100n);
  });
});
