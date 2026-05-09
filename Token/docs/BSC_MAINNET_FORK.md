# BSC 主网分叉验收手册

本文用于上线前验证链上合约和链下 operator 在真实 PancakeSwap V2 环境中的关键路径。

## 环境变量

复制 [Token/.env.example](../.env.example) 后填写：

```bash
export BSC_RPC_URL="https://your-bsc-rpc"
export PANCAKE_V2_ROUTER="0x10ED43C718714eb63d5aA57B78B54704E256024E"
export TOKEN_ADDRESS="0x..."
```

## Foundry fork 测试

```bash
cd Token
forge test --match-contract BscMainnetForkFlow -vvv --fork-url "$BSC_RPC_URL"
```

测试覆盖：

- 在 BSC fork 上部署 USCAME。
- 使用真实 Pancake V2 Router 初始化 LP。
- 用户先通过 `transfer(referrer, 0)` 完成绑定。
- 用户向 Token 合约直接入金。
- operator 执行 Pair 单边抽币。
- operator 把 BNB 转入 Vault。

如果未设置 `BSC_RPC_URL`，测试会直接跳过，避免影响本地普通单测。

## Rust operator 联动验收

在 Rust 工具链可用后运行：

```bash
cd Token/offchain
cargo test --all
cargo test --test full_flow -- --nocapture
```

Rust full-flow 是不连 RPC 的确定性业务模拟，负责验证事件幂等、分账比例、静态收益、团队奖励、LP 通缩、回购和出局逻辑。

## 上线阻断条件

- `initializeLP()` 不能在 fork 上通过真实 Pancake Router 创建 Pair。
- 普通用户未初始化前能入金。
- 非 operator 能调用 `operatorCall` 或 `pullPairTokens`。
- Deposit 事件不能被 Rust indexer 幂等处理。
- 任一收益周期重复执行会重复支付。
- Vault BNB 转移或回购失败后没有 pending/retry 记录。
- Pair reserve 与 Rust state 出现不可解释偏差。