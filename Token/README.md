# USCAMEX Token

This folder contains the token-side implementation for the USCAMEX protocol. The root repository remains the Next.js website; this subproject owns the Solidity contract, Foundry tests, the Cloudflare Worker offchain operator, and protocol tests.

## Architecture

- Chain: BSC-compatible EVM, planned for PancakeSwap V2 Router.
- Solidity: minimal trusted execution surface in `src/USCAME.sol`.
- Offchain: a Cloudflare Worker operator (`worker/`, TypeScript) owns the complex protocol accounting and timed execution. It runs the BSC indexer, deterministic engine, on-chain executor, and owner-authed admin API on Workers + Durable Objects + D1 + Cron Triggers.
- Database: Cloudflare D1 (SQLite) persists events, indexed blocks, protocol config snapshots, and node history. The engine `ProtocolState` and command journal live in the `OperatorDO` Durable Object storage.
- Binding: users bind an upline by transferring exactly `bindCost` tokens (default 11) to the upline via `transfer(referrer, bindCost)`. The tokens are delivered to the upline; a zero-value transfer no longer binds.
- LP seed: the 1 billion token supply is minted to the token contract. By default `initializeLP()` injects the token contract's full remaining balance; if the owner withdraws an admin reserve first, the pair receives `totalSupply - adminReserve`.

The Solidity contract intentionally exposes a strong `operatorCall` primitive so the offchain operator can execute Router, Vault, and distribution calls without expanding on-chain code size. Production operator ownership should be a multisig, and a timelock or whitelist should be considered before mainnet launch.

## Commands

Solidity syntax/import check available in this workspace:

```bash
pnpm token:solc-check
```

```bash
cd Token
forge fmt --check
forge build
forge test -vvv
forge test --match-contract BscMainnetForkFlow -vvv --fork-url "$BSC_RPC_URL"
```

```bash
cd Token/worker
pnpm install
pnpm typecheck
pnpm test
npx wrangler d1 create uscamex_operator      # then paste the id into wrangler.jsonc
npx wrangler d1 migrations apply uscamex_operator --remote
npx wrangler secret put BSC_RPC_URL
npx wrangler secret put OPERATOR_PRIVATE_KEY
pnpm deploy
```

Database schema for the production operator lives in `worker/migrations/0001_init.sql` (D1/SQLite). The Worker's `OperatorDO` runs migrations against D1 via `wrangler d1 migrations apply`, persists chain events, indexed blocks, protocol config snapshots, and node history, and holds the engine `ProtocolState` + execution journal in Durable Object storage. On each scan tick it reads the full protocol configuration and node list from the Token contract, reads `owner()`, `vault()`, Pair reserves, scans confirmed BSC logs, submits supported pending operator commands with the configured private key, waits for receipts, and serves the admin API. Executor safety settings can be adjusted with `EXECUTOR_SLIPPAGE_BPS`, `TRANSACTION_DEADLINE_SECONDS`, and `BURN_ADDRESS`.

The current workspace does not include Foundry binaries. Install `forge` and `anvil` before running the Solidity commands. The Worker operator needs Node + `wrangler` (already in `worker/`).

## Layout

- `docs/USER_FLOWS.md` - complete user/admin/operator scenario flows and acceptance matrix.
- `docs/BSC_MAINNET_FORK.md` - BSC mainnet fork validation runbook.
- `docs/LAUNCH_CHECKLIST.md` - production launch blockers, monitoring, and rollout order.
- `admin/` - static owner admin panel for chain and offchain operation.
- `src/USCAME.sol` - minimal ERC20 token, LP initialization, binding, tax, deposits, and operator execution.
- `src/interfaces/IPancake.sol` - Pancake V2 interfaces.
- `test/USCAME.t.sol` - Foundry unit tests with local Pancake-style mocks.
- `test/BscMainnetFork.t.sol` - optional BSC mainnet fork bootstrap test.
- `worker/` - Cloudflare Worker operator (TypeScript). See `worker/README.md` for the module map.
- `worker/src/engine.ts` - deterministic protocol accounting.
- `worker/src/service.ts` - orchestration that turns protocol state into operator commands.
- `worker/src/journal.ts` - idempotent command journal for retry and restart safety.
- `worker/src/storage.ts` - D1 persistence for events/blocks/config/node history.
- `worker/src/admin.ts` - HTTP admin API with owner-signature authorization.
- `worker/src/rpc.ts` - BSC JSON-RPC client for chain reads.
- `worker/src/env.ts` - settings parsing and validation.
- `worker/src/do.ts` - OperatorDO: indexing, accounting, persistence, command submission, scheduled ticks.
- `worker/migrations/0001_init.sql` - D1 schema for operator persistence.
- `worker/src/health.ts` - operational health checks for indexer lag, pending commands, gas, and reserves.