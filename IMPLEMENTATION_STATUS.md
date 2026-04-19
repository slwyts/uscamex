# USCAMEX Validation Status

## Current Status

- Default suite: `64 passing`, `9 pending`
- Real BSC mainnet fork suite: `9 passing`
- Pending items are expected in the default suite because fork tests are skipped unless `BSC_RPC_URL` is provided.

## Command Baseline

- Compile: `pnpm contracts:compile`
- Default suite: `pnpm contracts:test`
- Real Pancake fork suite: `BSC_RPC_URL=<rpc> pnpm contracts:test:fork`

## README Acceptance Matrix

| README Area | Expected Behavior | Validation Level | Current Status |
|---|---|---|---|
| Pancake V2 architecture | Uses real Pancake V2 router/factory/pair and native LP token | Real fork | Validated |
| Transfer interception | Buy/sell/LP remove flows are intercepted through transfer hooks | Unit + real fork | Validated |
| Lazy rewards | Rewards settle on interaction rather than push distribution | Unit | Validated |
| Node definition | Depositors become nodes and node weight tracks deposit amount | Unit | Validated |
| Binding by exact 10 tokens | Exact 10 token transfer binds referral, non-contract target only | Unit | Validated |
| Binding tree integrity | Referrer must already be in tree unless root owner | Unit | Validated |
| Buy tax | Buy disabled by default, buy tax split between dividend tokens and buyback BNB | Unit + real fork | Validated |
| Sell tax | Sell tax split to dividend, ecosystem, buyback; remaining sold tokens burned | Unit + real fork | Validated |
| Sell tax above 10% | Excess above 10% is burned to dead address | Unit | Validated |
| Deposit range and routing | Direct BNB deposit builds LP and splits funds by config | Unit + real fork | Validated |
| Node weighted payout | Deposit node portion is distributed by weight | Unit + real fork | Validated |
| Dividend pool purchase on deposit | Deposit dividend portion buys tokens into dividend pool | Unit + real fork | Validated |
| Direct referral payout | Deposit direct referral portion is paid in BNB or falls back to buyback reserve | Unit + real fork | Validated |
| LP withdrawal | Withdrawal burns token side and returns BNB side only | Unit + real fork | Validated |
| Exit mechanism | Reaching exit threshold closes position and stops cycle | Unit + real fork | Validated |
| Static reward update | Updated daily static rate applies immediately to future settlement logic | Unit | Validated |
| Dynamic reward ladder | Generation unlock depends on direct referral count up to 10 levels | Unit | Validated |
| Exited ancestor reward stop | Exited users stop receiving future dynamic propagation | Unit | Validated |
| LP deflation | Hourly deflation moves pair token inventory to dividend pool within daily cap | Unit + real fork | Validated |
| Buyback burn | Buyback consumes reserve each minute until reserve is insufficient or disabled | Unit + real fork | Validated |

## Real Fork Findings

- The project now uses an intermediate receiver contract to avoid Pancake V2 `INVALID_TO` when the token itself would otherwise be the swap recipient during deposit/dividend purchase flows.
- Real fork coverage now includes:
  - deployment against Pancake V2 mainnet addresses
  - deposit LP creation
  - full deposit routing across node, referral, dividend, and buyback legs
  - buy blocking
  - sell tax settlement
  - direct LP removal burn behavior
  - sequential trade tax accumulation and later settlement
  - buyback execution and insufficient reserve stop
  - LP deflation
  - exit-triggered auto-close on reward claim

## Remaining Gaps

- No deployment script or BscScan verification workflow is included yet.
- No UI/admin acceptance layer is included; current validation is contract and test only.
- Gas profiling on fork is not yet summarized into a dedicated report.

## Release Guidance

- Treat the real fork suite as the pre-launch gate for Pancake interaction safety.
- Keep `BSC_RPC_URL` backed by an archive-capable endpoint.
- If deposit routing or Pancake helper logic changes, rerun the full fork suite before merge.
