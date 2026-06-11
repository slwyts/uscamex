# BSC Mainnet Fork Validation Runbook

Use this before production deployment to prove the real Pancake V2 router/pair path,
the token contract, and the Worker operator agree on accounting.

## Prerequisites

- `forge` and `anvil` installed.
- A BSC mainnet RPC URL in `BSC_RPC_URL`.
- Node dependencies installed in `Token/worker`.

## Contract Fork Tests

Run the Solidity unit and fork suites:

```bash
cd Token
forge fmt --check
forge build
forge test -vvv
BSC_RPC_URL=<bsc-rpc> forge test --match-contract BscMainnetForkFlow -vvv
```

The fork suite covers:

- deployment against Pancake V2 router
- admin reserve before LP initialization
- `initializeLP()` with real pair reserves
- default config with `buyEnabled == false`
- `bindCost` referral binding
- node weight setup
- user native deposit
- atomic `depositBatch`
- deflation pull and vault buyback paths

## Local Anvil + Worker Loop

1. Start a local BSC fork:

```bash
anvil --fork-url "$BSC_RPC_URL" --chain-id 56
```

2. Deploy `USCAMEX` to the fork with Pancake V2 router:

```bash
cd Token
forge create src/USCAMEX.sol:USCAMEX \
  --rpc-url http://127.0.0.1:8545 \
  --private-key <owner-private-key> \
  --constructor-args \
  0x10ED43C718714eb63d5aA57B78B54704E256024E \
  <owner-address> \
  <operator-address>
```

3. Bootstrap the contract:

- Owner optionally withdraws the admin reserve from token self-custody.
- Owner sends `10 BNB` to the token contract.
- Owner calls `initializeLP()`.
- Owner calls `setNode(genesisNode, 1)`.

4. Configure the Worker to point at the fork. Use local vars or a temporary
   `wrangler.jsonc` edit:

```text
CHAIN_ID=56
RPC_URL=http://127.0.0.1:8545
TOKEN_ADDRESS=<fork-token>
PANCAKE_V2_ROUTER=0x10ED43C718714eb63d5aA57B78B54704E256024E
INDEXER_START_BLOCK=<deploy-block>
CONFIRMATIONS=1
AMM_FEE_BPS=9975
```

5. Start the Worker locally:

```bash
cd Token/worker
pnpm migrate:local
pnpm dev
```

6. Trigger scanning. In local dev, any `/api/*` request calls `ensureRunning()`
   and starts the Durable Object alarm scan loop:

```bash
curl http://127.0.0.1:8787/api/health
curl http://127.0.0.1:8787/api/admin/stats?force=1
curl http://127.0.0.1:8787/api/admin/journal-list?force=1
```

7. Trigger scheduled tasks manually. Wrangler local dev does not run Cloudflare
   Cron by itself. Use the scheduled test endpoint:

```bash
curl "http://127.0.0.1:8787/__scheduled?cron=*+*+*+*+*"
```

This executes `scheduled()` -> `OperatorDO.runScheduledTicks()` for settlement,
deflation, and buyback slot planning.

## Expected 1 BNB Deposit Result

After user A binds to root and sends `1 BNB` to the token contract:

- journal has one `deposit-batch` record for that deposit event
- record becomes `Confirmed`
- pair native reserve increases by `0.7 BNB`
- `BuybackVault` balance increases by `0.1 BNB`
- genesis node balance increases by `0.1 BNB`
- root/direct referrer balance increases by `0.1 BNB`
- token contract project-token balance increases from builder buy and any LP surplus
- token contract native balance for that deposit returns to zero

## Failure Handling

- A failed `deposit-batch` must leave pair reserves, vault, and payouts unchanged.
- Re-triggering scan must not create duplicate journal records for the same event.
- `POST /api/admin/retry-failed` requires owner signature; `?force` is read-only only.