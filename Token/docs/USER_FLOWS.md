# USCAMEX 用户交互与自动执行场景流

本文按 `origin.md` 设计上线后的完整业务场景。默认生产环境为 BSC 主网 + PancakeSwap V2，链下 Rust operator 是强信任自动执行者，负责监听事件、计算账本、发起链上交易和故障补偿。

## 角色与系统边界

| 角色 | 操作入口 | 负责内容 |
|---|---|---|
| 普通用户 | 官网 / 钱包 | 绑定上级、发送 BNB 入金、买卖代币、查看收益、撤出/重新入金 |
| 推荐人 | 官网 / 钱包 | 分享邀请地址，接收直推奖励和团队奖励 |
| 节点地址 | 管理后台登记 | 接收节点分红 |
| 管理员 owner | 管理后台 | 初始化 LP、调参数、必要时暂停/恢复买入、启动停止回购、管理 operator |
| Rust operator | 后台服务 | 事件索引、收益会计、定时任务、Router/Vault/分账执行 |
| Token 合约 | BSC 主网 | 发行、首次 LP、0 币绑定、入金事件、交易税、operator 执行入口 |
| Vault 子合约 | BSC 主网 | 持有回购 BNB，只接受 Token 合约调用 |

## 全局状态机

| 状态 | 进入条件 | 允许行为 | 禁止/注意 |
|---|---|---|---|
| PreInit | 合约刚部署 | owner 向 Token 转入初始 BNB，调用 `initializeLP()` | 普通用户 BNB 入金会 revert；Pair 尚未创建 |
| LPReady | `initializeLP()` 成功 | 用户可 0 币绑定；已绑定用户可入金；operator 可开始监听执行 | 未绑定用户直接入金会 revert；默认 `buyEnabled=false`，买入需后台开启 |
| ActivePosition | 用户已绑定且入金成功 | 静态收益、团队奖励、直推奖励、撤出、出局计算 | 重复任务必须幂等，不能重复支付 |
| Exited | 收益累计达到 N 倍或用户撤出 | 停止静态/动态收益；允许原地址重新入金 | 旧订单不再参与奖励 |
| BuybackRunning | 后台启动回购 | 每分钟按参数回购销毁 | Vault 没 BNB 或后台停止时终止 |

## 场景 1：部署与首次 LP

1. 管理员准备 BSC 主网 owner、operator 地址和 Pancake V2 Router。
2. 部署 `USCAME(router, owner, operator)`，显式 owner 自动作为推荐树 root。
3. 合约构造：发行 10 亿枚到 `address(this)`，部署 Vault，设置 owner/root 已绑定。
4. owner 向 Token 合约直接转入初始 BNB。
5. owner 调用 `initializeLP()`。
6. 合约把自身 100% Token 和全部 BNB 调 Pancake `addLiquidityETH`，记录 Pair。
7. Rust operator 从部署高度开始回放事件，确认 `PairInitialized`、Vault 地址、Pair reserves。

验收点：

- `initialized=true`，`pair != address(0)`。
- Token 合约初始 token 余额接近 0，Pair 持有 10 亿枚。
- 非 owner 再次调用 `initializeLP()` 或重复调用必须失败。
- 普通用户在 PreInit 阶段转 BNB 必须失败。

## 场景 2：绑定上级

1. 用户在官网输入或通过邀请链接带入上级地址。
2. 官网校验上级地址不是用户自己，并查询 `referrer[upper] != 0` 或 upper 是 root。
3. 用户钱包签名 `transfer(upper, 0)`。
4. 合约 `_update` 识别 0 金额转账，写入 `referrer[user] = upper`，发出 `RefBound`。
5. Rust indexer 捕获 `RefBound`，更新绑定树和上级直推人数。

分支：

- 上级未绑定：链上 revert，前端提示“上级未激活”。
- 用户已绑定：合约保持原绑定，0 币转账只产生普通 ERC20 事件。
- 用户未绑定就直接向 Token 合约转 BNB：链上 revert，前端应引导先绑定。
- 钱包不支持 0 金额输入：官网必须提供按钮直接构造交易。

## 场景 3：用户入金与 LP 建设

1. 用户已完成绑定。
2. 官网读取合约 `minDeposit/maxDeposit` 并校验金额。
3. 用户向 Token 合约直接发送 BNB。
4. 合约校验范围，发出 `Deposit(user, amount, referrer)`，BNB 暂留 Token 合约。
5. Rust indexer 捕获 `Deposit`，确认事件未处理过，写入数据库订单游标。
6. Rust engine 按后台参数计算：60% 组 LP、10% 节点、10% 建设者买入、10% Vault、10% 直推。
7. Rust executor 通过 `operatorCall` 和 `pullPairTokens` 依次执行：
   - 从 Pair 单边抽取等值项目代币到 Token 合约。
   - 用 30% BNB + 等值 Token 加 LP。
   - 节点 BNB 按权重分发。
   - 10% BNB 买入项目代币并留存在 Token 合约。
   - Vault 入账回购 BNB。
   - 直推奖励发给直接推荐人；直推比例调低时差额进 Vault。
8. Rust state 标记订单 active，记录本金、LP 份额估算、累计已支付为 0。

失败恢复：

- 某一步 Router 失败：订单保持 `pending_execution`，不重复记账，等待重试。
- 分账交易部分成功：按 receipt 标记每个命令的 tx hash，下一次只补未完成命令。
- Rust operator 使用数据库中的 `execution_commands` 记录 Pending、Submitted、Confirmed、Failed；服务重启后只重试未确认命令。
- 无节点地址：节点分红进入 Vault，不阻塞入金。

## 场景 4：买入 / 卖出与税费归集

买入：

1. 前期 `buyEnabled=false`，从 Pair 买入会 revert。
2. 管理员后台确认开放后调用 `setProtocolConfig(..., buyEnabled=true)`。
3. 用户在 Pancake 买入。
4. 合约对 Pair 转出到用户的转账收取买入 token 税，税先留在 Token 合约。
5. Rust operator 定期把税 token 兑换成 BNB，并按规则转 Vault 或其他目标。

卖出：

1. 用户向 Pancake 卖出 Token。
2. 合约对用户转入 Pair 的转账收取卖出 token 税，税先留在 Token 合约。
3. Rust operator 周期性处理税 token：生态基金 BNB 转 owner，回购 BNB 转 Vault，建设者部分留存或买回 token。

验收点：普通转账不收税，owner/operator/Token 合约免税，税率调整实时生效。

## 场景 5：静态收益与团队代数奖励

1. Rust scheduler 每 6 小时拉取 active 用户列表。
2. 对每个 active 订单计算本期静态收益：本金 BNB * 日收益率 / 4。
3. 按当时 Pair 价格折算为项目代币，通过 `operatorCall` 或 Token 余额执行发放。
4. 沿绑定树向上最多 10 代计算团队奖励；上级直推人数不足对应代数则跳过。
5. 写入用户累计静态/动态收益。
6. 若累计收益达到 N 倍本金，触发出局流程。

失败恢复：每个结算周期使用 `(user, position_id, period_start)` 做数据库唯一幂等键；重复回放不能重复发放。

## 场景 6：LP 底池单边通缩

1. Rust scheduler 每小时检查通缩开关。
2. 读取当天已抽取 bps，若达到每日上限 2% 则跳过。
3. 调用 `pullPairTokens(hourly_bps)`，把 Pair 项目代币转入 Token 合约并 `sync()`。
4. Rust state 更新当天已抽取 bps 和建设者池 token 余额。

验收点：Pair BNB reserve 不变，token reserve 下降；跨日重置每日上限；operator 以外地址调用失败。

## 场景 7：回购销毁

1. 管理员后台开启回购。
2. Rust scheduler 每分钟检查 Vault BNB 余额和开关。
3. 通过 Token 合约调用 Vault，使用固定 BNB 数量在 Pancake 买入 Token。
4. 买入 Token 发送到可销毁路径，调用 `burn` 或转黑洞。
5. Vault BNB 耗尽或后台关闭后停止。

失败恢复：滑点过大时跳过本分钟并记录告警；连续失败进入暂停态，等待管理员处理。

## 场景 8：用户撤出与出局

用户主动撤出：

1. 用户在官网点击撤出。
2. Rust server 校验订单 active，计算可取回 BNB 份额。
3. operator 销毁用户对应项目代币份额，仅返还 BNB。
4. 订单标记 exited，停止静态和动态收益。

自动出局：

1. 任何收益结算后，Rust 检查累计收益是否达到 N 倍本金。
2. 达标则执行同撤出流程。
3. 用户若要继续收益，用原地址重新入金建立新订单。

## 场景 9：后台参数调整

1. 管理员在后台修改参数。
2. 后台先做范围校验，例如税率不超过合约上限，入金 min <= max，分账 bps 总和 <= 100%。
3. 管理后台调用 `setProtocolConfig(...)` 或 `setNode(node,weight)`，所有管理员参数统一写入 Token 合约。
4. Rust operator 在启动和扫描确认区块前读取链上配置；链上真实生效参数由合约直接使用，链下执行参数只作为链上存储值供 operator 执行。

必须记录的审计字段：操作者、旧值、新值、链上 tx、启用区块、高度回滚处理状态。

## 上线前主网分叉验收矩阵

| 验收项 | BSC fork 动作 | 通过条件 |
|---|---|---|
| 首次 LP | fork BSC，部署 Token，调用真实 Pancake Router | Pair 创建成功，reserves 正确 |
| 绑定 | 多用户 `transfer(referrer, 0)` | 合法链路成功，断链失败 |
| 入金 | 用户向 Token 发 BNB | Deposit 事件和金额正确 |
| 未绑定入金 | 未绑定用户向 Token 发 BNB | 链上 revert，BNB 不进入合约 |
| operator | `pullPairTokens`、`operatorCall` | 非 operator 失败，operator 成功 |
| 税费 | Mock 或 fork swap | 买入关闭失败，开启后按 bps 扣税 |
| 自动任务 | Rust full-flow simulation | 入金、收益、团队、通缩、回购、出局全部幂等 |
| 恢复 | 重放事件、重复 tick、模拟服务重启、模拟 block hash 变化 | 不重复支付，不重复出局，重启后只补 pending，reorg 可检测 |

## 运行监控告警

- indexer 落后区块数超过阈值。
- pending 订单超过 1 个确认周期。
- operator 余额低于安全 gas 阈值。
- Vault 回购连续失败。
- Router 滑点失败次数异常。
- Pair reserve 与 Rust state 偏差超过阈值。
- 每日通缩 bps 接近或超过上限。
- 未授权调用失败次数异常。