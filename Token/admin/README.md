# USCAMEX Admin

静态管理员面板，用钱包直接管理链上合约，用 owner 签名访问 Rust operator 的链下管理接口。

## 本地打开

```bash
cd Token/admin
python3 -m http.server 5174
```

打开 `http://127.0.0.1:5174`。页面加载后会自动请求连接钱包，并在 Token 合约地址已填写时自动请求 owner 签名授权。

## 链下 API 鉴权

面板通过钱包 `personal_sign` 签名以下消息：

```text
USCAMEX Admin
address=<wallet>
token=<token address>
chainId=<chain id>
timestamp=<milliseconds>
```

Rust operator 会恢复签名地址，并通过 BSC RPC 调用 `owner()`，只有签名地址等于合约 owner 才能访问 `/api/admin/*`。

## 能力

- 读取链上 owner、operator、pair、vault、税率、入金范围、买入开关。
- 提交 `initializeLP()`。
- 提交 `setConfig(operator,buyTax,sellTax,minDeposit,maxDeposit,buyEnabled)`。
- 读取链下 `/api/health`、`/api/admin/overview`、`/api/admin/state`、`/api/admin/journal`。
- 读取和保存数据库业务参数：入金分配、静态收益、出局倍数、团队奖励、通缩、回购和税费分配。
