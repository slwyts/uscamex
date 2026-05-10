# USCAMEX Admin Panel

> 链上写、链下读：所有“配置修改”都直接走 owner 钱包对 USCAME 合约发交易；所有“数据查询”都来自 Rust operator 暴露的 `/api/admin/*`。

## 技术栈

- pnpm + Vite 5 + React 18 + TypeScript 5
- Ant Design 5（深色主题，金色品牌色）+ `@ant-design/icons`
- `react-router-dom` 6 + `@tanstack/react-query` 5
- ethers v6（注入式钱包 + 只读 RPC 双通道）

## 目录布局

```
src/
  components/   AddressTag, OwnerGate, TopBar
  hooks/        useWallet  (connect / authorize / disconnect)
  pages/
    QueryOverview.tsx       /admin/query/overview
    QueryTeam.tsx           /admin/query/team
    QueryUser.tsx           /admin/query/user
    QueryUsers.tsx          /admin/query/users
    QueryNodes.tsx          /admin/query/nodes
    QueryPositions.tsx      /admin/query/positions
    QueryJournal.tsx        /admin/query/journal
    QueryConfigHistory.tsx  /admin/query/config-history
    ConfigParams.tsx        /admin/config/params
    ConfigNodes.tsx         /admin/config/nodes
    ConfigLp.tsx            /admin/config/lp
  utils/        api.ts, chain.ts, contract.ts, settings.ts, bnb.ts, bps.ts, address.ts
```

## 本地开发

```bash
cd Token/admin
pnpm install
pnpm dev      # http://127.0.0.1:5179/admin/   ; /api 自动转发到 127.0.0.1:8787
```

需要 operator 在 `127.0.0.1:8787` 监听（可由 `OPERATOR_ADMIN_BIND` 配置）。

## 生产构建

```bash
cd Token/admin
pnpm build    # 产物：Token/admin/dist/
```

operator 启动时会自动检测 `USCAMEX_ADMIN_DIR`（默认 `../admin/dist`），如目录存在则将其挂在 `/admin` 路径下：

```
http://<operator>/admin/          -> SPA 入口
http://<operator>/api/admin/...   -> JSON API
```

## 鉴权流程

1. 在右上角“连接设置”里填入合约地址、链 ID、只读 RPC URL（默认 BSC 主网）。
2. 点“连接钱包”授权当前账户。
3. 点“签名授权后端”，会让钱包对一段包含 `token=...` 与 `chainId=...` 的消息做 personal_sign。
4. 后端校验：签名地址必须等于链上 `owner()`，否则返回 401/403。

> 签名只保留在浏览器内存中；切换账户、切换链、断开钱包都会立即清空。

## 数据查询板块概览

| 页面 | 数据来源 | 说明 |
| --- | --- | --- |
| 总览 | `/api/health`、`/api/admin/stats` | 公共健康 + 全协议关键指标 + 资金水位 |
| 团队结构 | `/api/admin/team` | 任意地址 BFS 直达 N 代下线，按代分组 |
| 用户详情 | `/api/admin/user` | 单用户全字段 + 推荐人 + 直推 |
| 用户列表 | `/api/admin/users` | 全协议用户分页/排序/过滤 |
| 节点收益 | `/api/admin/nodes` | 链下镜像的节点权重与累计奖励 |
| 持仓清单 | `/api/admin/positions` | 当前所有 position（活跃/已退场） |
| 执行流水 | `/api/admin/journal-list` | operator 命令队列（待执行/已提交/已确认/失败） |
| 配置历史 | `/api/admin/config-history` | 链下保存的协议配置快照 |

## 配置修改板块

| 页面 | 方法 | 说明 |
| --- | --- | --- |
| 业务参数 | `setProtocolConfig` | 一键提交所有 26 个参数（税/分配/通缩/回购/团队 10 代/退场倍数 等） |
| 节点管理 | `setNode(addr, weight)` | 添加 / 调权 / 删除（weight=0） |
| LP 初始化 | `initializeLP()` | 一次性初始化 PancakeSwap V2 池子 |

> 所有写操作都会先用钱包确认，并在 UI 中显示成功的 tx hash；提交完成后会自动重新读取链上最新值。

## 样式约定

- 主色：`#FFD700`（与 USCAMEX 品牌一致）
- 背景：`#0e0f13` + 双向径向高光
- 地址显示：`AddressTag` 组件支持 hover 提示完整地址 + 一键复制
- 数值显示：金额走 `formatBnb`（BigInt，最多 18 位精度），bps 走 `bpsToPercentText`
