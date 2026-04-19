# USCAMEX Parameter Recommendations

## Principle

The first-choice recommendation is to start from the README defaults unless there is an operational reason to diverge. The defaults already match the intended business model and the current tests are aligned with them.

## Recommended Launch Baseline

| Parameter | Recommended Initial Value | Source |
|---|---|---|
| Buy tax | 3% | README default |
| Buy tax split | 1% dividend / 2% buyback | README default |
| Sell tax | 10% | README default |
| Sell tax split | 3% dividend / 3% ecosystem / 4% buyback | README default |
| Buy enabled | `false` at first | README default |
| Deposit range | 0.1 - 5 BNB | README default |
| Deposit split | 60 / 10 / 10 / 10 / 10 | README default |
| Deflation enabled | `true` | README default |
| Deflation hourly rate | 0.1% | README default |
| Deflation daily cap | 2% | README default |
| Buyback active | `false` at launch | README default |
| Buyback per minute | 0.1 BNB | README default |
| Static daily rate | 0.8% | README default |
| Exit multiplier | 3x | README default |
| Operation mode at first public funding stage | `NODE_SALE` first, then `DEPOSIT` | Operational recommendation based on README flow |

## Recommended Rollout Sequence

### Phase 1: Node Sale Preparation

- `operationMode = NODE_SALE`
- `buyEnabled = false`
- `buyback.active = false`
- Keep README tax defaults unchanged
- Configure initial wallet addresses and any seed node addresses deliberately

Reason:
- This matches the README statement that early activity starts with node sale and that buy orders are not open initially.

### Phase 2: Deposit Opening

- Switch `operationMode = DEPOSIT`
- Keep `buyEnabled = false` until deposit routing and liquidity state are checked on chain
- Keep `buyback.active = false` until buyback reserve has accumulated meaningful balance

Reason:
- Deposits are the core LP-building path and should stabilize first.

### Phase 3: Buy Opening

- Enable buys only after:
  - pair and LP state are verified
  - deposit routing is behaving as expected
  - dividend pool inventory is sufficient for early claims

Reason:
- Buy-side opening is easy to control and should happen after the internal accounting paths are observed live.

### Phase 4: Buyback Activation

- Turn on `buyback.active = true` only after reserve accumulation is observable
- Start with README default `0.1 BNB/min` unless treasury size suggests a lower burn cadence is safer

Reason:
- The logic is already validated, but operational pacing still depends on actual reserve inflow.

## When To Deviate From README Defaults

Only consider deviations if one of these is true:

1. Node count is high enough that deposit gas becomes operationally uncomfortable
2. Dividend pool inventory is lower than projected early claim demand
3. Buyback reserve is accumulating too slowly or too aggressively for intended treasury pacing
4. Early market volatility makes the default sell-side pressure management too weak or too strong

## Conservative Alternative Suggestions

These are not replacements for the README defaults. They are fallback operating profiles if you want a softer initial launch:

| Parameter | Conservative Alternative | Why |
|---|---|---|
| Deposit max | 1 BNB | Limits oversized early deposits while observing system behavior |
| Buyback per minute | 0.03 - 0.05 BNB | Slower treasury drawdown during early observation |
| Direct referral ratio | Keep 10% unless there is a treasury reason to reduce | README economics are centered on direct referral behavior |
| Static daily rate | Keep 0.8% unless dividend pool inventory planning says otherwise | The reward model and exit timing are tuned around this baseline |

## Recommendation Summary

- Best launch baseline: use the README defaults unchanged
- Best operational sequence: `NODE_SALE` -> `DEPOSIT` -> enable buy -> enable buyback
- Only reduce parameters early if treasury pacing, gas growth, or live liquidity observations require it