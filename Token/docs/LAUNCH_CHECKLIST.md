# USCAMEX 上线检查清单

此清单用于 BSC 主网上线前的最后阻断检查。任一阻断项失败时，不应开放用户入金或买入。

## 1. 钱包与权限

- owner 地址由项目管理后台或部署方确认。
- operator 使用独立热钱包，BNB gas 余额高于告警阈值。
- 根推荐人固定为合约 owner，owner 不是零地址，且不建议与 operator 热钱包相同。
- operator 私钥只部署在后端安全环境，不进入前端或仓库。
- `DATABASE_URL` 指向独立 Postgres 实例，数据库账号最小权限可写业务 schema。
- `operatorCall` 权限风险已向运营方确认，后续版本计划白名单或 timelock。

## 2. 部署参数

- `PANCAKE_V2_ROUTER=0x10ED43C718714eb63d5aA57B78B54704E256024E`。
- `BSC_CHAIN_ID=56`。
- 初始 LP BNB 金额已由项目方确认，对应初始价格已复核。
- `minDeposit/maxDeposit` 与后台展示一致。
- 默认 `buyEnabled=false`，买入开放必须走后台确认流程。

## 3. 主网分叉验收

- `pnpm token:solc-check` 通过。
- `forge test -vvv` 通过。
- `forge test --match-contract BscMainnetForkFlow -vvv --fork-url "$BSC_RPC_URL"` 通过。
- Rust full-flow simulation 通过：`cargo test --all`。
- operator 数据库迁移已执行：`offchain/migrations/0001_operator_schema.sql`。
- operator 首次启动已从 Token 合约读取业务参数和节点列表，并写入数据库快照。
- operator HTTP 管理接口已启动，管理员面板直接通过钱包读写 Token 合约配置。
- BSC fork 中 `initializeLP()` 使用真实 Pancake Router 创建 Pair 成功。
- 非 owner 无法初始化 LP，非 operator 无法执行 `operatorCall` 和 `pullPairTokens`。

## 4. 自动执行与幂等

- indexer 从部署区块开始回放，`RefBound` 和 `Deposit` 事件幂等。
- 每个业务批次使用稳定 key，例如 `deposit:{tx_hash}:{log_index}`、`static:{user}:{period}`。
- `ExecutionJournal` 能记录 Pending、Submitted、Confirmed、Failed。
- 业务参数以 Token 合约当前配置为准，修改必须通过 owner 钱包提交链上交易。
- 服务重启后只重试 Failed/Pending，不重发 Confirmed。
- 部分命令成功时，下一轮只补未完成命令。
- 区块回滚时，已进入未确认窗口的事件需要重新校验 receipt。

## 5. 业务场景

- 用户 0 币绑定合法上级成功，断链上级失败。
- 未绑定用户直接入金失败，已绑定用户范围内入金成功。
- 用户直接向 Token 合约发送 BNB，范围内成功，范围外 revert。
- 入金后自动执行 LP 建设、节点分红、建设者买入、Vault 入账、直推奖励。
- 每 6 小时收益结算不会重复支付。
- 团队奖励按 1-10 代和直推人数门槛计算，门槛不足或上级 inactive 时跳过。
- 每小时 LP 单边抽币不超过每日上限。
- 回购在 Vault BNB 耗尽或后台关闭时停止。
- 达到 N 倍收益自动产生 `ExitPosition`，停止后续收益。
- 用户出局后原地址重新入金会创建新 active 订单。
- 买入/卖出税费归集路径覆盖 LP 建设者、Vault、owner 和销毁账本。

## 6. 监控告警

- indexer lag 大于阈值告警。
- pending command 数量大于 0 持续超过 1 个确认周期告警。
- operator BNB 余额低于阈值告警。
- Pair reserve 与 Rust state 偏差超过阈值告警。
- Vault 回购连续失败自动暂停。
- 每日通缩达到上限后不再执行抽币。
- 任意非授权调用失败次数异常时告警。

## 7. 开放顺序

1. 部署合约。
2. owner 预存初始 LP BNB。
3. 调用 `initializeLP()`。
4. 启动 Rust indexer/operator，只监听不执行，确认状态一致。
5. 开启 operator 执行，先处理小额内部账户入金。
6. 验证静态收益、通缩、Vault 入账和回购 dry run。
7. 开放普通用户入金。
8. 后台确认后再开启买入。