# USCAMEX User And Operator Flows

This document is the acceptance matrix for the token contract and Worker operator.
Amounts use native BNB/POL units depending on the deployed chain; the accounting
rules are the same.

## Launch Bootstrap

1. Deploy `USCAME(router, owner, operator)`.
2. Optionally transfer an admin reserve from the token contract before LP seeding,
   for example `10,000,000 USCAME`, using `operatorCall(token, 0, transfer(owner, amount))`.
3. Send the initial native seed, for example `10 BNB`, to the token contract from
   the owner while `initialized == false`.
4. Call `initializeLP()` once. The token contract receives all LP tokens.
5. Verify:
   - `initialized == true`
   - `pair != address(0)`
   - pair native reserve equals the seed amount
   - pair token reserve equals `totalSupply - adminReserve`
   - token contract owns the LP balance

## Referral Binding

Users bind by transferring exactly `bindCost` project tokens to a bound upline.
The default is `11 USCAME`.

Acceptance checks:

- `transfer(upline, bindCost)` from an unbound user binds the user and delivers
  the tokens to the upline.
- The upline must be root or already bound.
- `0` token transfers do not bind.
- A second `bindCost` transfer from an already bound user is only a normal transfer.

## Deposit Allocation

A normal user deposits by sending native currency directly to the token contract.
The contract emits `Deposit(user, amount, referrer)`. The Worker then computes and
submits one atomic `depositBatch` transaction.

For a `1 BNB` deposit with default config:

| Allocation | Amount | Execution |
| --- | ---: | --- |
| LP build | `0.6 BNB` | `0.3 BNB` buys tokens into the token contract, then `0.3 BNB` pairs with those tokens as LP held by the token contract |
| Node payout | `0.1 BNB` | Paid to active nodes by weight |
| Builder pool | `0.1 BNB` | Buys tokens into the token contract (`address(this)`) |
| Buyback vault | `0.1 BNB` | Sent to `BuybackVault` |
| Direct referral | `0.1 BNB` | Sent to the direct referrer, capped by exit room |

Acceptance checks:

- One `Deposit` event produces one `deposit-batch` journal record, plus optional
  independent `redeem-user-lp` records if a referrer exits.
- The batch succeeds or reverts as one transaction.
- Native allocations add up exactly to the deposit amount.
- Protocol-owned buys succeed even when `buyEnabled == false`.
- Ordinary DEX buys still revert while `buyEnabled == false`.

## Hourly Deflation

The Worker schedules deflation hourly when enabled.

Default rule:

- Pull `0.1%` of the current pair token reserve.
- Send the pulled tokens to the token contract itself.
- Pair native reserve stays unchanged.
- Daily cumulative pull is capped at `2%` and resets on a new day key.

Acceptance checks:

- `pullPairTokens(10)` reduces pair token reserve by `reserve * 10 / 10000`.
- Token contract project-token balance increases by the same amount.
- Pair reserves are synced after the pull.

## Static Rewards

Default static rate is `0.8%` daily, settled `4` times per day.

For `1 BNB` principal:

- Daily static value: `0.008 BNB`.
- Per-period value: `0.002 BNB`.
- The Worker pays project tokens by current pair price using
  `PayRewardTokenByBnbValue(amount=0.002 BNB)`.

Acceptance checks:

- Repeating the same period key does not pay twice.
- `staticPaidBnb` increases by the BNB-denominated value.
- Reward token amount follows current pair reserves.

## Dynamic Rewards

Dynamic rewards are paid during static settlement of downline users.

For A directly referring B:

- B's `1 BNB` position earns `0.002 BNB` static value per period.
- A has one direct referral, so A receives generation-1 reward:
  `0.002 BNB * 10% = 0.0002 BNB` value in project tokens.

Acceptance checks:

- A receives no dynamic reward before B exists and settles.
- Generation eligibility follows direct-count gates.
- `dynamicPaidBnb` increases by the BNB-denominated reward value.

## Exit And Re-entry

When `staticPaidBnb + dynamicPaidBnb` reaches `principalBnb * exitMultiple`, the
Worker plans LP redemption.

Acceptance checks:

- User LP share is redeemed from the token contract's LP custody.
- Returned project tokens are burned.
- Returned native currency goes to the user.
- The old position becomes inactive; re-deposit starts a new `positionId`.