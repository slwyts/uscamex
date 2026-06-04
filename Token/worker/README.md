# USCAMEX Operator — Cloudflare Worker

TypeScript Cloudflare Worker port of the Rust `Token/offchain` operator. Runs the BSC
indexer, deterministic protocol engine, on-chain executor, and owner-authed admin API on
Workers + Durable Objects + D1 + Cron Triggers.

## Architecture

| Rust offchain (`Token/offchain`) | This worker |
|---|---|
| `run_forever()` tokio loop | `OperatorDO` alarm (self-rescheduling poll) |
| Engine + journal (JSONB snapshots) | `OperatorDO` SQLite storage |
| Postgres (events/blocks/history) | D1 (`uscamex_operator`) |
| `rpc.rs` eth_call/eth_getLogs | `src/rpc.ts` (fetch) |
| `chain.rs` sign+send | `src/chain.ts` (viem) |
| `ws.rs` WS listener | dropped (HTTP polling baseline; WS optional later) |
| `admin_api.rs` axum + owner sig | `src/admin.ts` (EIP-191 owner sig) |
| Cron ticks (settlement/deflation/buyback) | Cron Trigger -> `OperatorDO.runScheduledTicks` |
| 14 inline `#[cfg(test)]` + 2 integration tests | deleted; minimal Vitest |

## Setup

```bash
cd Token/worker
pnpm install

# Create the D1 database and paste its id into wrangler.jsonc
npx wrangler d1 create uscamex_operator
npx wrangler d1 migrations apply uscamex_operator --local   # or --remote

# Secrets (NOT in wrangler.jsonc)
npx wrangler secret put BSC_RPC_URL
npx wrangler secret put OPERATOR_PRIVATE_KEY

pnpm dev        # local
pnpm deploy     # production (auto-builds the admin SPA first)
pnpm test       # vitest
pnpm typecheck
```

Non-secret config (chain id, token, router, confirmations, TTLs) lives in `wrangler.jsonc` `vars`.

## Admin panel (served by this Worker)

The Worker also serves the admin SPA (`Token/admin`) via Workers Static Assets:

- `wrangler.jsonc` `assets` points at `../admin/dist`, with
  `not_found_handling: "single-page-application"` (SPA fallback) and
  `run_worker_first: ["/api/*"]` so only `/api/*` hits Worker code; everything
  else is served as a static asset from the edge.
- `pnpm deploy` runs `predeploy` → `build:admin`, which installs + builds the
  admin app into `Token/admin/dist` before deploying. One command ships both.
- After deploy, the admin panel is at the Worker root URL (`https://<worker>/`).
  Append `?force` to skip the owner-signature gate (read-only bypass).

Local development has two options:
- **Worker-served (production-like):** `cd Token/admin && pnpm build`, then
  `cd Token/worker && pnpm dev` — visit the wrangler dev URL root.
- **Vite dev (hot reload):** `cd Token/admin && pnpm dev` (port 5179) with the
  Worker running on `:8787`; Vite proxies `/api` to it.

## Port status

Full logic port complete. All Rust modules are ported to TypeScript:

| TS module | Ports from | Status |
|---|---|---|
| `env.ts` | settings.rs | settings parse + validate |
| `config.ts` | config.rs | ProtocolConfig, defaults, validate, bps/bnb helpers |
| `state.ts` | state.rs | ProtocolState + (de)serialization for DO storage |
| `engine.ts` | engine.rs | deterministic accounting (bind/deposit/settle/deflation/buyback/tax) |
| `indexer.ts` | indexer.rs | topic constants + manual ABI log decoders |
| `rpc.ts` | rpc.rs | BSC JSON-RPC reads, getProtocolConfig word map |
| `executor.ts` | executor.rs | OperatorCommand union + command builders |
| `chain.ts` | chain.rs | tx build/sign/send (viem), operatorCall, AMM math |
| `journal.ts` | journal.rs | idempotent command journal + JSON round-trip |
| `service.ts` | service.rs | event→engine→journal orchestration, tax sweep planning |
| `storage.ts` | storage.rs | D1 adapter (events/blocks/config+node history) |
| `health.ts` | health.rs | operational health alerts |
| `do.ts` | runtime.rs + main.rs | OperatorDO: scan alarm loop, cron ticks, slot keys, admin queries |
| `admin.ts` | admin_api.rs | owner-authed routes, EIP-191 auth |
| `index.ts` | main.rs | Worker fetch + scheduled entry |

Tests: `test/{config,engine,indexer,journal}.test.ts` (21 cases, ported from the Rust unit tests).
Run with `pnpm test` (plain Node/vitest — pure logic, no workerd needed).

### Fidelity invariants (must not drift from the original Rust)

- All wei math is `bigint`; `BNB=10n**18n`, `BPS_DENOMINATOR=10000n`.
- `getProtocolConfig()` ABI word index map (0–34) in `rpc.ts` `CONFIG_WORD_INDEX`.
- `owner()` selector `0x8da5cb5b`; event topic set in `indexer.ts` `ALL_TOPICS`.
- Idempotency: `processed_events`, `processed_settlements`, journal batch-key dedupe,
  cron slot tags, confirmed-survives-restart.
- Settlement aligned to UTC+8 with `periods_per_day` embedded in the slot key.
- Admin auth: `x-uscamex-admin-message-b64` + `x-uscamex-admin-signature`, EIP-191 recover == on-chain `owner()`.
