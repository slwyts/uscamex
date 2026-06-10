/**
 * Protocol state. Port of Token/offchain/src/state.rs.
 * Addresses are lowercased hex strings. wei amounts are bigint.
 * Maps use plain objects keyed by address; sets use Set<string> (serialized as arrays).
 */

export type Address = string;

export interface Node {
  address: Address;
  weight: number;
}

export interface UserAccount {
  referrer: Address | null;
  directCount: number;
  /** Direct referrals that have invested at least once (active OR exited). Used for team-reward generation gating. */
  investedDirectCount: number;
  /** True once this account has ever made a deposit (stays true after exit). */
  hasInvested: boolean;
  positionId: bigint;
  principalBnb: bigint;
  staticPaidBnb: bigint;
  dynamicPaidBnb: bigint;
  /** BNB-denominated LP share contributed and not yet redeemed. */
  lpBnbPrincipal: bigint;
  /** Actual LP tokens minted for user deposits and held by the token contract. */
  lpTokenPrincipal: bigint;
  active: boolean;
  exited: boolean;
}

export function newUserAccount(): UserAccount {
  return {
    referrer: null,
    directCount: 0,
    investedDirectCount: 0,
    hasInvested: false,
    positionId: 0n,
    principalBnb: 0n,
    staticPaidBnb: 0n,
    dynamicPaidBnb: 0n,
    lpBnbPrincipal: 0n,
    lpTokenPrincipal: 0n,
    active: false,
    exited: false,
  };
}

export interface PairState {
  tokenReserve: bigint;
  bnbReserve: bigint;
}

export interface ProtocolBalances {
  vaultBnb: bigint;
  ownerBnb: bigint;
  builderTokenValueBnb: bigint;
  builderTokenAmount: bigint;
  burnedTokens: bigint;
  taxBurnedTokenValueBnb: bigint;
  nodePaidBnb: Map<Address, bigint>;
  directPaidBnb: Map<Address, bigint>;
  /** Sum of lpBnbPrincipal across all currently active users. */
  totalActiveLpPrincipalBnb: bigint;
}

export interface PendingTaxSweep {
  taxTokenAmount: bigint;
  builderTokenAmount: bigint;
  burnTokenAmount: bigint;
  ownerSellTokenAmount: bigint;
  vaultSellTokenAmount: bigint;
}

export function newPendingTaxSweep(): PendingTaxSweep {
  return {
    taxTokenAmount: 0n,
    builderTokenAmount: 0n,
    burnTokenAmount: 0n,
    ownerSellTokenAmount: 0n,
    vaultSellTokenAmount: 0n,
  };
}

export function newProtocolBalances(): ProtocolBalances {
  return {
    vaultBnb: 0n,
    ownerBnb: 0n,
    builderTokenValueBnb: 0n,
    builderTokenAmount: 0n,
    burnedTokens: 0n,
    taxBurnedTokenValueBnb: 0n,
    nodePaidBnb: new Map(),
    directPaidBnb: new Map(),
    totalActiveLpPrincipalBnb: 0n,
  };
}

export class ProtocolState {
  root: Address;
  users: Map<Address, UserAccount> = new Map();
  nodes: Node[] = [];
  balances: ProtocolBalances = newProtocolBalances();
  pair: PairState = { tokenReserve: 0n, bnbReserve: 0n };
  currentDay = 0n;
  deflationUsedBps = 0;
  processedEvents: Set<string> = new Set();
  processedSettlements: Set<string> = new Set();
  appliedDepositBatches: Set<string> = new Set();
  pendingTaxSweep: PendingTaxSweep = newPendingTaxSweep();

  constructor(root: Address) {
    this.root = root;
    const rootAcct = newUserAccount();
    rootAcct.referrer = root;
    rootAcct.active = true;
    this.users.set(root, rootAcct);
  }

  isBound(address: string): boolean {
    if (address === this.root) return true;
    const u = this.users.get(address);
    return !!u && u.referrer != null;
  }

  ensureUserMut(address: string): UserAccount {
    let u = this.users.get(address);
    if (!u) {
      u = newUserAccount();
      this.users.set(address, u);
    }
    return u;
  }

  user(address: string): UserAccount | undefined {
    return this.users.get(address);
  }
}

// ---- (de)serialization for Durable Object storage (bigint + Map/Set safe) ----

type SerializedUser = Omit<
  UserAccount,
  | "positionId"
  | "principalBnb"
  | "staticPaidBnb"
  | "dynamicPaidBnb"
  | "lpBnbPrincipal"
  | "lpTokenPrincipal"
  | "investedDirectCount"
  | "hasInvested"
> & {
  positionId: string;
  principalBnb: string;
  staticPaidBnb: string;
  dynamicPaidBnb: string;
  lpBnbPrincipal: string;
  lpTokenPrincipal?: string;
  investedDirectCount?: number;
  hasInvested?: boolean;
};

export interface SerializedState {
  root: string;
  users: [string, SerializedUser][];
  nodes: Node[];
  balances: {
    vaultBnb: string;
    ownerBnb: string;
    builderTokenValueBnb: string;
    builderTokenAmount: string;
    burnedTokens: string;
    taxBurnedTokenValueBnb: string;
    nodePaidBnb: [string, string][];
    directPaidBnb: [string, string][];
    totalActiveLpPrincipalBnb: string;
  };
  pair: { tokenReserve: string; bnbReserve: string };
  currentDay: string;
  deflationUsedBps: number;
  processedEvents: string[];
  processedSettlements: string[];
  appliedDepositBatches?: string[];
  pendingTaxSweep?: {
    taxTokenAmount: string;
    builderTokenAmount: string;
    burnTokenAmount: string;
    ownerSellTokenAmount: string;
    vaultSellTokenAmount: string;
  };
}

export function serializeState(s: ProtocolState): SerializedState {
  return {
    root: s.root,
    users: [...s.users.entries()].map(([addr, u]) => [
      addr,
      {
        referrer: u.referrer,
        directCount: u.directCount,
        investedDirectCount: u.investedDirectCount,
        hasInvested: u.hasInvested,
        active: u.active,
        exited: u.exited,
        positionId: u.positionId.toString(),
        principalBnb: u.principalBnb.toString(),
        staticPaidBnb: u.staticPaidBnb.toString(),
        dynamicPaidBnb: u.dynamicPaidBnb.toString(),
        lpBnbPrincipal: u.lpBnbPrincipal.toString(),
        lpTokenPrincipal: u.lpTokenPrincipal.toString(),
      },
    ]),
    nodes: s.nodes,
    balances: {
      vaultBnb: s.balances.vaultBnb.toString(),
      ownerBnb: s.balances.ownerBnb.toString(),
      builderTokenValueBnb: s.balances.builderTokenValueBnb.toString(),
      builderTokenAmount: s.balances.builderTokenAmount.toString(),
      burnedTokens: s.balances.burnedTokens.toString(),
      taxBurnedTokenValueBnb: s.balances.taxBurnedTokenValueBnb.toString(),
      nodePaidBnb: [...s.balances.nodePaidBnb.entries()].map(([k, v]) => [k, v.toString()]),
      directPaidBnb: [...s.balances.directPaidBnb.entries()].map(([k, v]) => [k, v.toString()]),
      totalActiveLpPrincipalBnb: s.balances.totalActiveLpPrincipalBnb.toString(),
    },
    pair: { tokenReserve: s.pair.tokenReserve.toString(), bnbReserve: s.pair.bnbReserve.toString() },
    currentDay: s.currentDay.toString(),
    deflationUsedBps: s.deflationUsedBps,
    processedEvents: [...s.processedEvents],
    processedSettlements: [...s.processedSettlements],
    appliedDepositBatches: [...s.appliedDepositBatches],
    pendingTaxSweep: serializePendingTaxSweep(s.pendingTaxSweep),
  };
}

export function deserializeState(d: SerializedState): ProtocolState {
  const s = new ProtocolState(d.root);
  let needsInvestedDirectRebuild = false;
  s.users = new Map(
    d.users.map(([addr, u]) => {
      if (u.investedDirectCount == null) needsInvestedDirectRebuild = true;
      return [addr, {
        referrer: u.referrer,
        directCount: u.directCount,
        investedDirectCount: u.investedDirectCount ?? 0,
        hasInvested: u.hasInvested ?? (BigInt(u.principalBnb) > 0n || u.exited),
        active: u.active,
        exited: u.exited,
        positionId: BigInt(u.positionId),
        principalBnb: BigInt(u.principalBnb),
        staticPaidBnb: BigInt(u.staticPaidBnb),
        dynamicPaidBnb: BigInt(u.dynamicPaidBnb),
        lpBnbPrincipal: BigInt(u.lpBnbPrincipal),
        lpTokenPrincipal: BigInt(u.lpTokenPrincipal ?? "0"),
      }];
    }),
  );
  s.nodes = d.nodes;
  s.balances = {
    vaultBnb: BigInt(d.balances.vaultBnb),
    ownerBnb: BigInt(d.balances.ownerBnb),
    builderTokenValueBnb: BigInt(d.balances.builderTokenValueBnb),
    builderTokenAmount: BigInt(d.balances.builderTokenAmount),
    burnedTokens: BigInt(d.balances.burnedTokens),
    taxBurnedTokenValueBnb: BigInt(d.balances.taxBurnedTokenValueBnb),
    nodePaidBnb: new Map(d.balances.nodePaidBnb.map(([k, v]) => [k, BigInt(v)])),
    directPaidBnb: new Map(d.balances.directPaidBnb.map(([k, v]) => [k, BigInt(v)])),
    totalActiveLpPrincipalBnb: BigInt(d.balances.totalActiveLpPrincipalBnb),
  };
  s.pair = { tokenReserve: BigInt(d.pair.tokenReserve), bnbReserve: BigInt(d.pair.bnbReserve) };
  s.currentDay = BigInt(d.currentDay);
  s.deflationUsedBps = d.deflationUsedBps;
  s.processedEvents = new Set(d.processedEvents);
  s.processedSettlements = new Set(d.processedSettlements);
  s.appliedDepositBatches = new Set(d.appliedDepositBatches ?? []);
  s.pendingTaxSweep = d.pendingTaxSweep ? deserializePendingTaxSweep(d.pendingTaxSweep) : newPendingTaxSweep();
  if (needsInvestedDirectRebuild) rebuildInvestedDirectCounts(s);
  return s;
}

function serializePendingTaxSweep(pending: PendingTaxSweep): SerializedState["pendingTaxSweep"] {
  return {
    taxTokenAmount: pending.taxTokenAmount.toString(),
    builderTokenAmount: pending.builderTokenAmount.toString(),
    burnTokenAmount: pending.burnTokenAmount.toString(),
    ownerSellTokenAmount: pending.ownerSellTokenAmount.toString(),
    vaultSellTokenAmount: pending.vaultSellTokenAmount.toString(),
  };
}

function deserializePendingTaxSweep(pending: NonNullable<SerializedState["pendingTaxSweep"]>): PendingTaxSweep {
  return {
    taxTokenAmount: BigInt(pending.taxTokenAmount),
    builderTokenAmount: BigInt(pending.builderTokenAmount),
    burnTokenAmount: BigInt(pending.burnTokenAmount),
    ownerSellTokenAmount: BigInt(pending.ownerSellTokenAmount),
    vaultSellTokenAmount: BigInt(pending.vaultSellTokenAmount),
  };
}

export function rebuildInvestedDirectCounts(s: ProtocolState): void {
  for (const account of s.users.values()) account.investedDirectCount = 0;
  for (const [addr, account] of s.users) {
    if (!account.hasInvested) continue;
    const referrer = account.referrer;
    if (!referrer || referrer === addr) continue;
    s.ensureUserMut(referrer).investedDirectCount += 1;
  }
}
