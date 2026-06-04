/**
 * Operational health alerts. Port of Token/offchain/src/health.rs.
 */
import type { ExecutionJournal } from "./journal";
import type { ProtocolState } from "./state";

export interface HealthConfig {
  maxIndexerLagBlocks: bigint;
  maxPendingCommands: number;
  minOperatorBnb: bigint;
  maxReserveDriftBps: number;
  deflationDailyCapBps: number;
}

export function defaultHealthConfig(): HealthConfig {
  return {
    maxIndexerLagBlocks: 12n,
    maxPendingCommands: 0,
    minOperatorBnb: 100_000_000_000_000_000n, // 0.1 BNB
    maxReserveDriftBps: 30,
    deflationDailyCapBps: 200,
  };
}

export interface HealthSnapshot {
  chainHead: bigint;
  indexedBlock: bigint;
  operatorBnb: bigint;
  observedPairToken: bigint;
  observedPairBnb: bigint;
}

export type HealthAlert =
  | { kind: "IndexerLag"; lagBlocks: bigint }
  | { kind: "PendingCommands"; count: number }
  | { kind: "LowOperatorBnb"; balance: bigint }
  | { kind: "PairReserveDrift"; tokenDriftBps: number; bnbDriftBps: number }
  | { kind: "DailyDeflationCapReached" };

const U16_MAX = 65_535;

export function checkHealth(
  config: HealthConfig,
  state: ProtocolState,
  journal: ExecutionJournal,
  snapshot: HealthSnapshot,
): HealthAlert[] {
  const alerts: HealthAlert[] = [];
  const lagBlocks = snapshot.chainHead > snapshot.indexedBlock ? snapshot.chainHead - snapshot.indexedBlock : 0n;
  const pendingCount = journal.pendingCommands().length;
  const tokenDriftBps = driftBps(state.pair.tokenReserve, snapshot.observedPairToken);
  const bnbDriftBps = driftBps(state.pair.bnbReserve, snapshot.observedPairBnb);

  if (lagBlocks > config.maxIndexerLagBlocks) alerts.push({ kind: "IndexerLag", lagBlocks });
  if (pendingCount > config.maxPendingCommands) alerts.push({ kind: "PendingCommands", count: pendingCount });
  if (snapshot.operatorBnb < config.minOperatorBnb) {
    alerts.push({ kind: "LowOperatorBnb", balance: snapshot.operatorBnb });
  }
  if (tokenDriftBps > config.maxReserveDriftBps || bnbDriftBps > config.maxReserveDriftBps) {
    alerts.push({ kind: "PairReserveDrift", tokenDriftBps, bnbDriftBps });
  }
  if (state.deflationUsedBps >= config.deflationDailyCapBps) {
    alerts.push({ kind: "DailyDeflationCapReached" });
  }
  return alerts;
}

function driftBps(expected: bigint, observed: bigint): number {
  if (expected === observed) return 0;
  if (expected === 0n) return U16_MAX;
  const diff = (expected > observed ? expected : observed) - (expected < observed ? expected : observed);
  const drift = (diff * 10_000n) / expected;
  return Number(drift > BigInt(U16_MAX) ? BigInt(U16_MAX) : drift);
}
