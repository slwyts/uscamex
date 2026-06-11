# Production Launch Checklist

## Before Deploy

- `forge fmt --check`
- `forge build`
- `forge test -vvv`
- `BSC_RPC_URL=<bsc-rpc> forge test --match-contract BscMainnetForkFlow -vvv`
- `cd Token/worker && pnpm typecheck && pnpm test`
- `cd Token/admin && npx tsc -p tsconfig.json --noEmit`

## Contract Setup

- Confirm router address for the target chain.
- Confirm owner address.
- Confirm operator address derived from the Worker private key.
- Deploy `USCAMEX(router, owner, operator)`.
- Record deploy transaction, block, token address, vault address, and pair after init.
- If using admin reserve, withdraw it before `initializeLP()`.
- Send initial native seed to the token contract.
- Call `initializeLP()` once.
- Set initial node weights with `setNode`.

## Worker Setup

- Apply D1 migrations.
- Set `RPC_URL` secret.
- Set `OPERATOR_PRIVATE_KEY` secret.
- Set `TOKEN_ADDRESS` to the new contract.
- Set `INDEXER_START_BLOCK` to the deployment block.
- Set chain metadata and router vars.
- Deploy Worker and admin assets.

## Smoke Test

- `/api/health` returns the new token and correct chain metadata.
- `/api/admin/stats?force=1` has non-null `last_indexed_block` after scan.
- A test user can bind by transferring `11 USCAMEX` to root.
- The test user can deposit a small valid native amount.
- Journal shows one confirmed `deposit-batch`.
- No failed commands remain.
- Vault, node, direct referrer, pair reserves, and token self-balance match the
  expected allocation for the test deposit.

## Rollback Notes

- Deploying a fresh token address creates a fresh Durable Object namespace key
  because the Worker uses `operator:${TOKEN_ADDRESS.toLowerCase()}`.
- Do not clear production D1 until the Worker is already deployed with the new
  token address, otherwise an old Worker instance may repopulate old state.