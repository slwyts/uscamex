# USCAMEX Token

This folder contains the token-side implementation for the USCAMEX protocol. The root repository remains the Next.js website; this subproject owns the Solidity contract, Foundry tests, Rust offchain operator, and protocol tests.

## Architecture

- Chain: BSC-compatible EVM, planned for PancakeSwap V2 Router.
- Solidity: minimal trusted execution surface in `src/USCAME.sol`.
- Offchain: Rust operator/server owns the complex protocol accounting and timed execution.
- Database: Postgres is the production persistence target for events, positions, command journal, settlement periods, config snapshots, health snapshots, and operator state snapshots.
- Binding: users bind an upline by calling `transfer(referrer, 0)`.
- LP seed: 100% of the 1 billion token supply is minted to the token contract and injected during `initializeLP()`.

The Solidity contract intentionally exposes a strong `operatorCall` primitive so the Rust operator can execute Router, Vault, and distribution calls without expanding on-chain code size. Production operator ownership should be a multisig, and a timelock or whitelist should be considered before mainnet launch.

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
cd Token/offchain
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --all
cargo run
```

Database schema for the production operator lives in `offchain/migrations/0001_operator_schema.sql`. The Rust `PostgresDatabase` adapter can run the migration and persist chain events, indexed blocks, protocol state, execution journal, and snapshots from `DATABASE_URL`. `cargo run` loads the production environment, validates BSC settings, connects to Postgres, runs migrations, reads the full protocol configuration and node list from the Token contract, reads `owner()`, `vault()`, Pair reserves, starts the confirmed-block BSC event scanner, submits supported pending operator commands with the configured private key, waits for receipts, and serves the admin API. Executor safety settings can be adjusted with `EXECUTOR_SLIPPAGE_BPS`, `TRANSACTION_DEADLINE_SECONDS`, and `BURN_ADDRESS`.

The live executor broadcasts direct Token calls (`TransferBnb`, `CreditVault`, `PullPairTokens`) and resolves runtime Pair quotes for `AddLiquidity`, `BuilderBuy`, `Buyback`, reward token payouts, and exit burns before signing transactions. Exits are generated as separate `exit-burn` and `exit-refund` journal commands: the burn command destroys the quoted token amount from the Token contract's own balance, and the refund command transfers BNB to the user. Insufficient contract token or BNB balance fails the specific command instead of silently underpaying.

Admin panel:

```bash
cd Token/admin
python3 -m http.server 5174
```

The panel uses the wallet for on-chain transactions. Business parameters such as deposit allocation, static yield, exit multiple, team rewards, deflation, buyback settings, tax splits, and node weights are stored on the Token contract and updated through owner-only calls. The Rust operator treats the chain as the configuration source and refreshes those values before processing confirmed logs.

The current workspace does not include Foundry or Rust binaries. Install `forge`, `anvil`, `cargo`, and `rustc` before running the commands.

## Layout

- `docs/USER_FLOWS.md` - complete user/admin/operator scenario flows and acceptance matrix.
- `docs/BSC_MAINNET_FORK.md` - BSC mainnet fork validation runbook.
- `docs/LAUNCH_CHECKLIST.md` - production launch blockers, monitoring, and rollout order.
- `admin/` - static owner admin panel for chain and offchain operation.
- `src/USCAME.sol` - minimal ERC20 token, LP initialization, binding, tax, deposits, and operator execution.
- `src/interfaces/IPancake.sol` - Pancake V2 interfaces.
- `test/USCAME.t.sol` - Foundry unit tests with local Pancake-style mocks.
- `test/BscMainnetFork.t.sol` - optional BSC mainnet fork bootstrap test.
- `offchain/src/engine.rs` - deterministic protocol accounting.
- `offchain/src/workflow.rs` - offchain automation workflow that turns protocol state into operator commands.
- `offchain/src/journal.rs` - idempotent command journal for retry and service restart safety.
- `offchain/src/storage.rs` - memory and Postgres persistence, restart/reorg tests, and JSON snapshot round-trips.
- `offchain/src/admin_api.rs` - HTTP admin API with owner-signature authorization.
- `offchain/src/rpc.rs` - minimal BSC JSON-RPC client for owner and block reads.
- `offchain/src/settings.rs` - production environment parsing and validation.
- `offchain/src/service.rs` - operator service layer that combines indexing, accounting, persistence, and command submission.
- `offchain/migrations/0001_operator_schema.sql` - Postgres schema for operator persistence.
- `offchain/src/health.rs` - operational health checks for indexer lag, pending commands, gas, and reserves.
- `offchain/tests/full_flow.rs` - Rust full-flow simulation of the field-sale protocol.