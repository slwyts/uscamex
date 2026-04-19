# USCAMEX Release Checklist

## Goal

This checklist is the minimum release gate for deploying and operating the contract suite against PancakeSwap V2 on BSC.

## 1. Environment

- Confirm `pnpm install` completes cleanly
- Confirm `pnpm contracts:compile` passes
- Confirm archive-capable `BSC_RPC_URL` is available
- Prefer a Hardhat-supported Node.js version for CI/release runners

## 2. Mandatory Test Gates

- Run `pnpm contracts:test`
- Run `BSC_RPC_URL=<archive_rpc> pnpm contracts:test:fork`
- Review [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md)
- Review [GAS_AND_RISK_REPORT.md](GAS_AND_RISK_REPORT.md)

## 3. Pancake Integration Checks

- Verify router address is Pancake V2 mainnet router
- Verify factory address is Pancake V2 mainnet factory
- Verify pair is created and LP tokens are held where expected
- Confirm deposit flow succeeds on fork with the current `SwapReceiver` intermediate route

## 4. Parameter Review Before Launch

- Buy enabled state intentionally set
- Deposit mode intentionally set (`NODE_SALE` or `DEPOSIT`)
- Buy tax config reviewed
- Sell tax config reviewed
- Deposit min/max reviewed
- Deposit split reviewed
- Deflation config reviewed
- Buyback config reviewed
- Reward rate and exit multiplier reviewed
- Wallet addresses reviewed:
  - dividend pool
  - ecosystem fund
  - buyback wallet

## 5. Dividend Pool Readiness

- Confirm dividend pool has sufficient token inventory for expected early claims
- Confirm no admin action will unexpectedly drain dividend inventory

## 6. Node And Referral Readiness

- Confirm root referral behavior is understood by operators
- Confirm initial node addresses, if any, are configured intentionally
- Confirm expected node count will not create unacceptable deposit gas costs

## 7. Operational Runbook

Before enabling live flows, operators should know how to:

- switch operation mode
- enable/disable buys
- activate/deactivate buyback
- adjust reward rate
- adjust deposit range
- manage nodes
- monitor dividend pool and buyback reserve

## 8. Post-Deployment Smoke Tests

On deployed contracts, perform the following in order with small amounts:

1. create pair / verify liquidity state
2. test referral binding with exact 10 token transfer
3. test one small deposit
4. verify node/referral/dividend/buyback routing from that deposit
5. test one small buy after enabling buys
6. test one small sell and verify later settlement
7. test one reward claim after settlement window

## 9. Launch-Day Monitoring

Watch these values closely:

- `buybackReserve`
- `dailyDeflationAmount`
- dividend pool token balance
- node payout correctness on deposits
- ecosystem wallet BNB receipts after sell settlement
- dead address token growth after burns and buybacks

## 10. Change Management Rule

If any code changes touch these areas, rerun both default and fork suites before release:

- `_update()` logic in [contracts/USCAMEX.sol](contracts/USCAMEX.sol)
- deposit routing in [contracts/USCAMEX.sol](contracts/USCAMEX.sol)
- reward settlement in [contracts/RewardEngine.sol](contracts/RewardEngine.sol)
- Pancake helpers in [contracts/libraries/SwapHelper.sol](contracts/libraries/SwapHelper.sol)
- fork deployment wiring in [test/helpers/deploy.ts](test/helpers/deploy.ts)