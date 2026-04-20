# USCAMEX Smart Contracts

BSC (Binance Smart Chain) token contract system with automated LP management, tax mechanisms, reward distributions, and referral tracking.

## Overview

USCAMEX is a comprehensive DeFi token system built on BSC using PancakeSwap V2. The system consists of multiple contracts working together to provide:

- **Automated Tax System**: Configurable buy/sell taxes
- **LP Management**: Automated liquidity provision and deflation
- **Reward Engine**: Static and dynamic rewards with lazy evaluation
- **Referral System**: 10-generation team reward tracking
- **Node System**: Weighted node distribution mechanism
- **Buyback & Burn**: Automated token buyback and burning

## Architecture

The system uses a multi-contract architecture to stay under the 24KB contract size limit:

```
┌─────────────────┐
│  USCAMEX.sol    │  Main ERC20 token contract
│  (Token Logic)  │  - Transfer interception
└────────┬────────┘  - Tax collection
         │           - LP operations
         │
    ┌────┴────┬──────────────────┐
    │         │                  │
┌───▼──────┐ ┌▼───────────────┐ ┌▼─────────────┐
│ Manager  │ │ RewardEngine   │ │  Libraries   │
│          │ │                │ │              │
│ Config   │ │ Static/Dynamic │ │ ReferralTree │
│ Params   │ │ Rewards        │ │ SwapHelper   │
└──────────┘ └────────────────┘ └──────────────┘
```

## Contracts

### USCAMEX.sol
Main ERC20 token contract with custom transfer logic.

**Key Features:**
- Total supply: 1 billion tokens (1% for referrals, 99% for LP)
- Buy/sell tax interception in `_update()` function
- Referral binding via exact 10-token transfers
- Dual operation modes: NODE_SALE and DEPOSIT
- LP deflation mechanism
- Buyback and burn functionality

**Important Functions:**
- `createPairAndAddLiquidity()`: Initialize PancakeSwap pair
- `receive()`: Handle BNB deposits (mode-dependent)
- `withdrawLP()`: Remove liquidity (burns tokens, returns BNB only)
- `claimRewards()`: Claim accumulated rewards
- `executeDeflation()`: Trigger hourly LP deflation
- `executeBuyback()`: Trigger per-minute buyback

### USCAMEXManager.sol
Central configuration contract for all parameters.

**Configurable Parameters:**
- Tax rates and distributions (buy/sell)
- Deposit limits and allocations
- LP deflation settings
- Buyback configuration
- Reward rates and exit multipliers
- Node management
- Core wallet addresses

**Key Functions:**
- `setTaxConfig()`: Update tax parameters
- `setDepositConfig()`: Update deposit parameters
- `setOperationMode()`: Switch between NODE_SALE/DEPOSIT modes
- `addNode()` / `removeNode()`: Manage node addresses
- `setBuyEnabled()`: Enable/disable buying

### RewardEngine.sol
Handles all reward calculations and distributions.

**Features:**
- Lazy evaluation (rewards calculated on-demand)
- Static rewards: 0.8% daily (default), paid every 6 hours
- Dynamic rewards: Based on downline static rewards (10 generations)
- Exit mechanism: Automatic exit when rewards reach 3x deposit (default)
- BNB-based calculations, token-denominated payouts

**Key Functions:**
- `recordDeposit()`: Record user deposit
- `claim()`: Settle and return pending rewards
- `bindReferral()`: Bind referral relationships
- `getPendingRewards()`: View pending rewards without settling

### Libraries

#### ReferralTree.sol
Manages the referral relationship tree structure.

**Functions:**
- `bind()`: Create referral relationship
- `getReferrer()`: Get user's direct referrer
- `getAncestors()`: Get up to N generations of ancestors
- `getDescendantsAtLevel()`: Get all descendants at specific generation
- `getDirectReferralCount()`: Count direct referrals (determines unlocked generations)

#### SwapHelper.sol
Encapsulates PancakeSwap V2 interactions.

**Functions:**
- `buyTokensWithExactBNB()`: Buy tokens with BNB
- `addLiquidityBNB()`: Add BNB/Token liquidity
- `getTokenPriceInBNB()`: Get current token price
- `getBNBEquivalent()`: Convert token amount to BNB value
- `calculateOptimalTokenAmount()`: Calculate optimal tokens for LP

## Token Economics

### Supply Distribution
- **Total Supply**: 1,000,000,000 tokens
- **Binding Pool**: 10,000,000 tokens (1%) - for referral binding
- **Liquidity Pool**: 990,000,000 tokens (99%) - initial LP

### Tax Structure

**Buy Tax: 3% (default, configurable)**
- 1% → Dividend Pool (tokens)
- 2% → Buyback Wallet (BNB)

**Sell Tax: 10% (default, configurable)**
- 3% → Dividend Pool (tokens)
- 3% → Ecosystem Fund (BNB)
- 4% → Buyback Wallet (BNB)
- Remaining tokens → Burned
- If sell tax > 10%, excess → Burned

### Deposit Distribution (60/10/10/10/10)
When users deposit BNB in DEPOSIT mode:
- **60%**: Build LP (30% BNB + 30% buy tokens)
- **10%**: Node weighted distribution
- **10%**: Buy tokens for dividend pool
- **10%**: Direct to buyback wallet
- **10%**: Direct referral reward (or to buyback if no referrer)

### Rewards System

**Static Rewards:**
- Daily rate: 0.8% of deposit (default, configurable)
- Settlement: Every 6 hours (0.2% per settlement)
- Calculation: BNB-based, paid in tokens

**Dynamic Rewards (Team Rewards):**
Based on direct referral count:
- 1 referral → 10% of Gen 1 static rewards
- 2 referrals → +9% of Gen 2
- 3 referrals → +8% of Gen 3
- ...
- 10 referrals → +5% of Gen 10

**Exit Mechanism:**
- User exits when (static + dynamic) ≥ deposit × exit multiplier (default 3x)
- On exit: tokens burned, BNB returned
- Must re-deposit to continue earning

## Key Mechanisms

### Referral Binding
Transfer **exactly 10 tokens** to bind that address as your referrer.

**Requirements:**
- Target must not be a contract
- Target must already have a referrer (or be owner/root)
- Can only bind once per address

### Operation Modes

**NODE_SALE Mode:**
- BNB sent to contract → registers sender as node
- Node weight = BNB amount
- Nodes receive weighted share of node distribution

**DEPOSIT Mode:**
- BNB sent to contract → creates LP position
- Records deposit in RewardEngine
- Distributes BNB according to deposit config

### LP Deflation
- Frequency: Every 1 hour
- Rate: 0.1% per hour (default, configurable)
- Daily cap: 2% (default, configurable)
- Mechanism: Removes tokens from pair → dividend pool
- Must be triggered externally (anyone can call)

### Buyback & Burn
- Triggered: Every 1 minute (when active)
- Amount: 0.1 BNB per minute (default, configurable)
- Process: Use BNB to buy tokens → send to dead address
- Auto-stops when buyback wallet BNB exhausted

## Development

### Setup

```bash
npm install
```

### Compile

```bash
npx hardhat compile
```

### Test

```bash
npx hardhat test
```

### Deploy (Example)

```typescript
// Deploy Manager
const Manager = await ethers.getContractFactory("USCAMEXManager");
const manager = await Manager.deploy(dividendPool, ecosystemFund, buybackWallet);

// Deploy RewardEngine
const RewardEngine = await ethers.getContractFactory("RewardEngine");
const rewardEngine = await RewardEngine.deploy(manager.address);

// Deploy Token
const Token = await ethers.getContractFactory("USCAMEX");
const token = await Token.deploy(manager.address, rewardEngine.address, pancakeRouter);

// Link RewardEngine to Token
await rewardEngine.setTokenContract(token.address);

// Create pair and add initial liquidity
await token.createPairAndAddLiquidity({ value: ethers.parseEther("10") });
```

## Testing Structure

```
test/
├── helpers/
│   ├── constants.ts      # Test constants and default configs
│   ├── deploy.ts         # Deployment helpers
│   ├── pancakeswap.ts    # PancakeSwap mock deployment
│   └── time.ts           # Time manipulation utilities
├── unit/
│   ├── Manager.test.ts   # Manager contract tests
│   ├── Token.test.ts     # Token contract tests
│   ├── Rewards.test.ts   # Reward system tests
│   └── ...               # Other unit tests
└── integration/
    └── FullFlow.test.ts  # End-to-end scenarios
```

## Security Considerations

1. **Tax Exemptions**: Owner, contract, and specified addresses are tax-exempt
2. **Owner Controls**: All parameter changes are owner-only
3. **Reentrancy**: Uses OpenZeppelin's ERC20 which has reentrancy protections
4. **Exit Conditions**: Users automatically exit at configured multiplier
5. **Referral Validation**: Prevents orphaned referral chains

## Important Notes

1. **Network**: Designed for BSC (chainId: 56)
2. **Router**: Uses PancakeSwap V2 Router
3. **Compiler**: Solidity 0.8.34 with optimizer enabled
4. **Gas**: All external triggers (deflation, buyback) are gas-paid by caller
5. **Decimals**: Standard 18 decimals for ERC20

## Admin Functions

**Manager:**
- `setTaxConfig()`, `setDepositConfig()`, `setDeflationConfig()`, etc.
- `setOperationMode()`: Switch modes
- `addNode()`, `removeNode()`: Manage nodes
- `setBuyEnabled()`: Control buy access

**Token:**
- `setTaxExempt()`: Add/remove tax exemptions
- `rescueTokens()`, `rescueBNB()`: Emergency rescue functions

## License

MIT
