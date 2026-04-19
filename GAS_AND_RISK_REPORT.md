# USCAMEX Gas And Risk Report

## Scope

This report summarizes the current gas hotspots, real-fork findings, and launch risks observed from the contract suite and the BSC mainnet fork tests.

## Command Baseline

- Compile: `pnpm contracts:compile`
- Default suite with gas table: `pnpm contracts:test`
- Real Pancake fork suite: `BSC_RPC_URL=<archive_rpc> pnpm contracts:test:fork`

## Notable Gas Hotspots

The current default test suite gas table highlights the following expensive paths:

| Method | Approx Avg Gas | Notes |
|---|---:|---|
| `USCAMEX.createPairAndAddLiquidity` | ~5,199,028 | One-time setup cost; acceptable but should not be part of repeated admin flows |
| `USCAMEX.claimRewards` | ~341,015 | Includes settlement, transfer, and exit-close branch when applicable |
| `USCAMEX.withdrawMyLP` | ~386,030 | Includes LP removal and token-side burn |
| `MockPancakeRouter.swapExactTokensForETH` | ~278,543 | Useful as relative signal for taxed sell flow complexity |
| `USCAMEX.transfer` | ~104,386 average | Wide range because plain transfers and automation-triggering transfers share the same entrypoint |
| `USCAMEX.executeDeflation` | ~121,902 | Acceptable hourly maintenance cost |

## Real Fork Findings

### 1. Deposit routing needed a real Pancake fix

- Real Pancake V2 rejects swap outputs when the recipient is one of the pair tokens.
- The deposit/dividend buy path originally sent bought tokens directly to the token contract.
- This produced `Pancake: INVALID_TO` on fork.
- The issue is now mitigated through [contracts/SwapReceiver.sol](contracts/SwapReceiver.sol), which acts as an intermediate receiver.

### 2. Mock and fork coverage now overlap on critical money flows

Real fork tests now validate:

- deposit LP creation
- deposit routing to node payout, referral payout, dividend pool purchase, and buyback reserve
- buy blocking
- taxed sell settlement
- LP removal token burn
- buyback execution and stop condition
- deflation transfer from pair to dividend pool
- exit-triggered auto-close
- referral-driven dynamic reward propagation

### 3. Gas-sensitive areas to monitor on launch

- `claimRewards` on users close to exit threshold
- `withdrawMyLP` under volatile price conditions
- deposits when multiple node addresses exist
- transfers that also trigger automation (`_runAutomation`)

## Launch Risks

### High

1. Archive RPC dependency for regression confidence
   - Real Pancake validation depends on an archive-capable BSC RPC.
   - Public non-archive RPCs can fail with missing trie node errors.

2. Transfer entrypoint complexity
   - Buy/sell/LP add/LP remove/automation all converge through `_update()` in [contracts/USCAMEX.sol](contracts/USCAMEX.sol).
   - Any future change here needs immediate fork retesting.

3. Reward and exit interactions
   - Reward settlement can cascade into auto-close logic.
   - Parameter updates to reward rate or exit multiplier should always be verified against both unit and fork flows.

### Medium

1. Node list growth
   - `_distributeToNodes` loops across all node addresses.
   - Large node sets will raise deposit gas costs linearly.

2. Operational timing assumptions
   - Deflation and buyback rely on time-gated external/user-triggered calls.
   - If interaction volume is low, maintenance actions may happen later than expected.

3. Dividend pool inventory dependency
   - Reward claims require sufficient dividend pool token balance.
   - Admin operations should avoid draining the dividend pool below expected claim demand.

### Low

1. Node.js version warning in local Hardhat runs
   - Current environment shows a Hardhat warning for Node.js v25.
   - Tests pass, but CI or release runners should ideally use a Hardhat-supported Node.js version.

## Recommended Pre-Launch Gates

1. Run `pnpm contracts:test`
2. Run `BSC_RPC_URL=<archive_rpc> pnpm contracts:test:fork`
3. Recheck gas table after any `_update`, deposit, reward, or buyback logic change
4. Reconfirm dividend pool inventory assumptions against projected claim volume

## Current Conclusion

The highest-risk Pancake integration issue found so far has already been fixed and validated on mainnet fork. The remaining main risks are operational: RPC quality, gas growth from node fan-out, and keeping fork regression mandatory for every core flow change.