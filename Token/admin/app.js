const selectors = {
  owner: "0x8da5cb5b",
  operator: "0x570ca735",
  root: "0xebf0c717",
  pair: "0xa8aa1b31",
  vault: "0xfbfa77cf",
  buyEnabled: "0xf582d293",
  buyTaxBps: "0xc473413a",
  sellTaxBps: "0xcffd129c",
  minDeposit: "0x41b3d185",
  maxDeposit: "0x6083e59a",
  initializeLP: "0xa6690cf9",
  setConfig: "0xf2810676",
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const state = {
  account: "",
  authMessage: "",
  authSignature: "",
  protocolConfig: null,
};

const $ = (id) => document.getElementById(id);

function setText(id, value) {
  const node = $(id);
  if (node) node.textContent = value;
}

function setStatus(id, value, tone = "") {
  const node = $(id);
  if (!node) return;
  node.textContent = value;
  node.dataset.tone = tone;
}

function setAddress(id, address) {
  const node = $(id);
  if (!node) return;
  node.textContent = shortAddress(address);
  node.title = address;
}

function toast(message) {
  const node = $("toast");
  node.textContent = message;
  node.classList.add("show");
  window.setTimeout(() => node.classList.remove("show"), 3600);
}

function settings() {
  return {
    rpcUrl: $("rpcUrl").value.trim(),
    chainId: $("chainId").value.trim(),
    tokenAddress: normalizeAddress($("tokenAddress").value.trim()),
    apiBase: $("apiBase").value.trim().replace(/\/$/, ""),
  };
}

async function saveSettings() {
  localStorage.setItem("uscamex-admin-settings", JSON.stringify(settings()));
  clearAuth();
  if (state.account && isTokenConfigured()) await signAdmin({ silent: true });
  await refreshAll({ silent: true });
  toast("连接信息已保存");
}

function loadSettings() {
  const raw = localStorage.getItem("uscamex-admin-settings");
  if (!raw) return;
  const stored = JSON.parse(raw);
  for (const [key, value] of Object.entries(stored)) {
    const node = $(key);
    if (node && value) node.value = value;
  }
}

async function connectWallet({ silent = false } = {}) {
  if (!window.ethereum) throw new Error("未检测到钱包");
  setStatus("walletStatus", "等待钱包确认", "warn");
  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
  if (!accounts.length) throw new Error("钱包未返回账户");
  state.account = normalizeAddress(accounts[0]);
  setAddress("walletStatus", state.account);
  setStatus("walletStatus", shortAddress(state.account), "ok");
  $("walletStatus").title = state.account;
  if (!silent) toast("钱包已连接");
  return state.account;
}

async function signAdmin({ silent = false } = {}) {
  if (!state.account) await connectWallet({ silent: true });
  if (!isTokenConfigured()) {
    setStatus("authStatus", "待填写合约", "warn");
    throw new Error("请先在底部填写 Token 合约地址");
  }
  const config = settings();
  const message = [
    "USCAMEX Admin",
    `address=${state.account}`,
    `token=${config.tokenAddress}`,
    `chainId=${config.chainId}`,
    `timestamp=${Date.now()}`,
  ].join("\n");
  setStatus("authStatus", "等待钱包签名", "warn");
  const signature = await window.ethereum.request({
    method: "personal_sign",
    params: [message, state.account],
  });
  state.authMessage = message;
  state.authSignature = signature;
  setStatus("authStatus", "已授权", "ok");
  if (!silent) toast("管理权限已授权");
  return signature;
}

function clearAuth() {
  state.authMessage = "";
  state.authSignature = "";
  setStatus("authStatus", "待重新授权", "warn");
}

function authHeaders() {
  if (!state.authMessage || !state.authSignature) throw new Error("请先签名授权");
  return {
    "x-uscamex-admin-message": state.authMessage,
    "x-uscamex-admin-signature": state.authSignature,
  };
}

async function apiGet(path, auth = false) {
  const response = await fetch(`${settings().apiBase}${path}`, {
    headers: auth ? authHeaders() : undefined,
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(body.error || response.statusText);
  return body;
}

async function apiPut(path, payload, auth = false) {
  const headers = { "content-type": "application/json" };
  if (auth) Object.assign(headers, authHeaders());
  const response = await fetch(`${settings().apiBase}${path}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(body.error || response.statusText);
  return body;
}

async function loadOffchainOverview({ silent = false } = {}) {
  setStatus("serviceStatusValue", "连接中", "warn");
  let publicHealth;
  try {
    publicHealth = await apiGet("/api/health");
  } catch (error) {
    setStatus("serviceStatusValue", "未连接", "bad");
    setText("offchainSummary", "后台 API 未连接");
    setText("offchainOverview", error.message);
    throw error;
  }

  setStatus(
    "serviceStatusValue",
    publicHealth.ok ? "运行中" : "异常",
    publicHealth.ok ? "ok" : "bad",
  );
  setText("chainHeadValue", publicHealth.chain_head ? publicHealth.chain_head.toString() : "-");

  let admin = null;
  if (state.authSignature) {
    try {
      admin = await apiGet("/api/admin/overview", true);
      setAddress("ownerStatus", admin.owner);
      setText("pendingValue", `${admin.pending_commands}`);
      setStatus(
        "dbSnapshotValue",
        admin.protocol_config_initialized ? "已初始化" : "待初始化",
        admin.protocol_config_initialized ? "ok" : "warn",
      );
    } catch (error) {
      setText("pendingValue", "需授权");
      setStatus("dbSnapshotValue", "需授权", "warn");
      setStatus("authStatus", "需重新授权", "warn");
      admin = { error: error.message };
    }
  } else {
    setText("pendingValue", "待授权");
    setStatus("dbSnapshotValue", "待授权", "warn");
  }

  const pendingText = admin && typeof admin.pending_commands === "number"
    ? `${admin.pending_commands} 个待执行`
    : "执行队列待授权";
  setText("offchainSummary", `服务运行中 · ${pendingText}`);
  $("offchainOverview").textContent = JSON.stringify({ publicHealth, admin }, null, 2);
  if (!silent) toast("后台状态已刷新");
}

async function loadProtocolConfig({ silent = false } = {}) {
  if (!state.authSignature) await signAdmin({ silent: true });
  const body = await apiGet("/api/admin/config", true);
  state.protocolConfig = body.config;
  fillProtocolConfigForm(body.config);
  setStatus("dbSnapshotValue", "已初始化", "ok");
  setText("protocolConfigSummary", "业务参数已从数据库加载");
  if (!silent) toast("业务参数已刷新");
  return body.config;
}

async function saveProtocolConfig() {
  if (!state.authSignature) await signAdmin({ silent: true });
  if (!state.protocolConfig) await loadProtocolConfig({ silent: true });
  const payload = protocolConfigPayload();
  const body = await apiPut("/api/admin/config", payload, true);
  state.protocolConfig = body.config;
  fillProtocolConfigForm(body.config);
  setText("protocolConfigSummary", "业务参数已保存到数据库");
  setStatus("dbSnapshotValue", "已初始化", "ok");
  toast("业务参数已保存");
}

async function loadState() {
  if (!state.authSignature) await signAdmin({ silent: true });
  const body = await apiGet("/api/admin/state", true);
  $("stateOutput").textContent = JSON.stringify(body, null, 2);
  toast("用户账本已加载");
}

async function loadJournal() {
  if (!state.authSignature) await signAdmin({ silent: true });
  const body = await apiGet("/api/admin/journal", true);
  $("journalOutput").textContent = JSON.stringify(body, null, 2);
  toast("执行队列已加载");
}

async function loadChain({ silent = false } = {}) {
  if (!window.ethereum) throw new Error("未检测到钱包");
  if (!isTokenConfigured()) {
    setStatus("syncStatus", "待填写合约", "warn");
    return false;
  }
  setStatus("syncStatus", "读取链上", "warn");
  const owner = decodeAddress(await ethCall(selectors.owner));
  const operator = decodeAddress(await ethCall(selectors.operator));
  const pair = decodeAddress(await ethCall(selectors.pair));
  const vault = decodeAddress(await ethCall(selectors.vault));
  const buyEnabled = decodeBool(await ethCall(selectors.buyEnabled));
  const buyTax = decodeUint(await ethCall(selectors.buyTaxBps));
  const sellTax = decodeUint(await ethCall(selectors.sellTaxBps));
  const minDeposit = decodeUint(await ethCall(selectors.minDeposit));
  const maxDeposit = decodeUint(await ethCall(selectors.maxDeposit));

  setAddress("ownerStatus", owner);
  setAddress("operatorValue", operator);
  setAddress("pairValue", pair);
  setAddress("vaultValue", vault);
  setStatus("buyEnabledValue", buyEnabled ? "已开放" : "未开放", buyEnabled ? "ok" : "warn");
  setText("buyTaxValue", `${formatBpsPercent(buyTax)}%`);
  setText("sellTaxValue", `${formatBpsPercent(sellTax)}%`);
  setText("depositRangeValue", `${formatBnb(minDeposit)} - ${formatBnb(maxDeposit)} BNB`);
  $("nextOperator").value = operator;
  $("nextBuyTax").value = formatBpsPercent(buyTax);
  $("nextSellTax").value = formatBpsPercent(sellTax);
  $("nextMinDeposit").value = formatBnb(minDeposit);
  $("nextMaxDeposit").value = formatBnb(maxDeposit);
  $("nextBuyEnabled").checked = buyEnabled;
  setStatus("syncStatus", "链上已同步", "ok");
  if (!silent) toast("链上数据已刷新");
  return true;
}

async function initializeLp() {
  await sendTransaction(selectors.initializeLP);
}

async function applyConfig() {
  const buyTaxBps = parsePercentBps($("nextBuyTax").value.trim());
  const sellTaxBps = parsePercentBps($("nextSellTax").value.trim());
  if (buyTaxBps > 2500n || sellTaxBps > 2500n) throw new Error("手续费不能超过 25%");
  const data = selectors.setConfig
    + encodeAddress($("nextOperator").value.trim())
    + encodeUint(buyTaxBps)
    + encodeUint(sellTaxBps)
    + encodeUint(parseBnb($("nextMinDeposit").value.trim()))
    + encodeUint(parseBnb($("nextMaxDeposit").value.trim()))
    + encodeUint($("nextBuyEnabled").checked ? 1n : 0n);
  await sendTransaction(data);
}

async function ethCall(data) {
  const result = await window.ethereum.request({
    method: "eth_call",
    params: [{ to: settings().tokenAddress, data }, "latest"],
  });
  return result;
}

async function sendTransaction(data) {
  if (!state.account) await connectWallet({ silent: true });
  const hash = await window.ethereum.request({
    method: "eth_sendTransaction",
    params: [{ from: state.account, to: settings().tokenAddress, data }],
  });
  toast(`交易已提交 ${hash}`);
  return hash;
}

async function refreshAll({ silent = false } = {}) {
  setStatus("syncStatus", "刷新中", "warn");
  const results = await Promise.allSettled([
    loadChain({ silent: true }),
    loadOffchainOverview({ silent: true }),
    state.authSignature ? loadProtocolConfig({ silent: true }) : Promise.resolve(),
  ]);
  const failed = results.find((result) => result.status === "rejected");
  if (failed) {
    setStatus("syncStatus", "部分异常", "warn");
    if (!silent) toast(failed.reason.message);
    return;
  }
  setStatus("syncStatus", "已同步", "ok");
  if (!silent) toast("数据已刷新");
}

function fillProtocolConfigForm(config) {
  $("configMinDeposit").value = config.min_deposit_bnb;
  $("configMaxDeposit").value = config.max_deposit_bnb;
  setPercentInput("configLpBuild", config.lp_build_bps);
  setPercentInput("configNode", config.node_bps);
  setPercentInput("configBuilderBuy", config.builder_buy_bps);
  setPercentInput("configVault", config.vault_bps);
  setPercentInput("configDirectPool", config.direct_pool_bps);
  setPercentInput("configDirectReward", config.direct_reward_bps);
  setPercentInput("configDailyStatic", config.daily_static_bps);
  $("configPeriodsPerDay").value = config.settlement_periods_per_day;
  setPercentInput("configExitMultiple", config.exit_multiple_bps);
  config.team_reward_bps.forEach((rate, index) => setPercentInput(`configTeam${index + 1}`, rate));
  $("configDeflationEnabled").checked = config.deflation_enabled;
  setPercentInput("configDeflationHourly", config.deflation_hourly_bps);
  setPercentInput("configDeflationDailyCap", config.deflation_daily_cap_bps);
  $("configBuybackEnabled").checked = config.buyback_enabled;
  $("configBuybackPerMinute").value = config.buyback_per_minute_bnb;
  setPercentInput("configBuyTaxBuilder", config.buy_tax_builder_bps);
  setPercentInput("configBuyTaxVault", config.buy_tax_vault_bps);
  setPercentInput("configSellTaxBuilder", config.sell_tax_builder_bps);
  setPercentInput("configSellTaxOwner", config.sell_tax_owner_bps);
  setPercentInput("configSellTaxVault", config.sell_tax_vault_bps);
}

function protocolConfigPayload() {
  const current = state.protocolConfig || {};
  return {
    ...current,
    min_deposit_bnb: $("configMinDeposit").value.trim(),
    max_deposit_bnb: $("configMaxDeposit").value.trim(),
    lp_build_bps: percentBpsNumber("configLpBuild"),
    node_bps: percentBpsNumber("configNode"),
    builder_buy_bps: percentBpsNumber("configBuilderBuy"),
    vault_bps: percentBpsNumber("configVault"),
    direct_pool_bps: percentBpsNumber("configDirectPool"),
    direct_reward_bps: percentBpsNumber("configDirectReward"),
    daily_static_bps: percentBpsNumber("configDailyStatic"),
    settlement_periods_per_day: Number.parseInt($("configPeriodsPerDay").value.trim(), 10),
    exit_multiple_bps: percentBpsNumber("configExitMultiple"),
    team_reward_bps: Array.from({ length: 10 }, (_, index) => percentBpsNumber(`configTeam${index + 1}`)),
    deflation_enabled: $("configDeflationEnabled").checked,
    deflation_hourly_bps: percentBpsNumber("configDeflationHourly"),
    deflation_daily_cap_bps: percentBpsNumber("configDeflationDailyCap"),
    buyback_enabled: $("configBuybackEnabled").checked,
    buyback_per_minute_bnb: $("configBuybackPerMinute").value.trim(),
    buy_tax_builder_bps: percentBpsNumber("configBuyTaxBuilder"),
    buy_tax_vault_bps: percentBpsNumber("configBuyTaxVault"),
    sell_tax_builder_bps: percentBpsNumber("configSellTaxBuilder"),
    sell_tax_owner_bps: percentBpsNumber("configSellTaxOwner"),
    sell_tax_vault_bps: percentBpsNumber("configSellTaxVault"),
  };
}

function setPercentInput(id, bps) {
  $(id).value = formatBpsPercent(BigInt(bps));
}

function percentBpsNumber(id) {
  const value = parsePercentBps($(id).value.trim());
  if (value > 1000000n) throw new Error("百分比数值过大");
  return Number(value);
}

function normalizeAddress(value) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) return value.toLowerCase();
  return `0x${value.slice(2).toLowerCase()}`;
}

function shortAddress(value) {
  const address = normalizeAddress(value || "");
  if (!/^0x[0-9a-f]{40}$/.test(address)) return value || "-";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function isTokenConfigured() {
  const tokenAddress = settings().tokenAddress;
  return /^0x[0-9a-f]{40}$/.test(tokenAddress) && tokenAddress !== ZERO_ADDRESS;
}

function stripWord(value) {
  return value.replace(/^0x/, "").padStart(64, "0");
}

function decodeAddress(value) {
  const word = stripWord(value);
  return normalizeAddress(`0x${word.slice(24)}`);
}

function decodeUint(value) {
  return BigInt(value || "0x0");
}

function decodeBool(value) {
  return decodeUint(value) !== 0n;
}

function encodeAddress(value) {
  const address = normalizeAddress(value).replace(/^0x/, "");
  if (address.length !== 40) throw new Error("地址格式错误");
  return address.padStart(64, "0");
}

function encodeUint(value) {
  return value.toString(16).padStart(64, "0");
}

function parsePercentBps(value) {
  const [whole, fraction = ""] = value.split(".");
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction) || fraction.length > 2) {
    throw new Error("手续费请输入百分比，最多两位小数");
  }
  return BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2));
}

function formatBpsPercent(value) {
  const bps = BigInt(value);
  const whole = bps / 100n;
  const fraction = (bps % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function parseBnb(value) {
  const [whole, fraction = ""] = value.split(".");
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction) || fraction.length > 18) {
    throw new Error("BNB 数量格式错误");
  }
  return BigInt(whole) * 10n ** 18n + BigInt((fraction + "0".repeat(18)).slice(0, 18));
}

function formatBnb(wei) {
  const whole = wei / 10n ** 18n;
  const fraction = (wei % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function bind(id, handler) {
  const node = $(id);
  if (!node) return;
  node.addEventListener("click", () => handler().catch((error) => toast(error.message)));
}

function setupWalletListeners() {
  if (!window.ethereum || !window.ethereum.on) return;
  window.ethereum.on("accountsChanged", () => autoConnectAndAuthorize());
  window.ethereum.on("chainChanged", () => refreshAll({ silent: true }).catch((error) => toast(error.message)));
}

async function autoConnectAndAuthorize() {
  try {
    await connectWallet({ silent: true });
    if (isTokenConfigured()) await signAdmin({ silent: true });
    await refreshAll({ silent: true });
  } catch (error) {
    if (!window.ethereum) {
      setStatus("walletStatus", "未检测到钱包", "bad");
      setStatus("authStatus", "无法授权", "bad");
    } else {
      setStatus(
        "walletStatus",
        state.account ? shortAddress(state.account) : "未连接",
        state.account ? "ok" : "warn",
      );
      setStatus("authStatus", isTokenConfigured() ? "待授权" : "待填写合约", "warn");
    }
    setStatus("syncStatus", error.message, "warn");
  }
}

loadSettings();
bind("saveSettings", saveSettings);
bind("signAdmin", signAdmin);
bind("loadChain", loadChain);
bind("loadOffchain", loadOffchainOverview);
bind("refreshAll", refreshAll);
bind("loadProtocolConfig", loadProtocolConfig);
bind("saveProtocolConfig", saveProtocolConfig);
bind("loadState", loadState);
bind("loadJournal", loadJournal);
bind("initializeLp", initializeLp);
bind("applyConfig", applyConfig);
setupWalletListeners();
autoConnectAndAuthorize();