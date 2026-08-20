/**
 * Returns true only when a successful RPC snapshot is still inside its TTL.
 * Timestamps live in the Durable Object instance and are deliberately
 * non-durable: an eviction merely causes a fresh read, never stale accounting.
 */
export function rpcSnapshotIsFresh(
  lastSuccessMs: number,
  ttlSecs: number,
  nowMs = Date.now(),
): boolean {
  if (lastSuccessMs <= 0 || ttlSecs <= 0) return false;
  const ageMs = nowMs - lastSuccessMs;
  return ageMs >= 0 && ageMs < ttlSecs * 1_000;
}
