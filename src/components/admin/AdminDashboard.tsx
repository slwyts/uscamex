"use client";

import { useEffect, useMemo, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  isAddress,
  parseEther,
  type Address,
  type Hash,
} from "viem";
import { bsc, bscTestnet } from "viem/chains";
import {
  formatBnb,
  formatToken,
  managerAbi,
  modeLabel,
  shortAddress,
  treasuryVaultAbi,
  tokenAbi,
} from "@/lib/admin-contracts";

type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

type RuntimeConfig = {
  rpcUrl: string;
  chainId: string;
  managerAddress: string;
  tokenAddress: string;
};

type Snapshot = {
  managerOwner: Address;
  operationMode: number;
  buyEnabled: boolean;
  dividendPool: Address;
  ecosystemFund: Address;
  buybackWallet: Address;
  dividendPoolBnbBalance: bigint;
  ecosystemFundBnbBalance: bigint;
  buybackWalletBnbBalance: bigint;
  dividendPoolTokenBalance: bigint;
  ecosystemFundTokenBalance: bigint;
  buybackWalletTokenBalance: bigint;
  dividendPoolIsContract: boolean;
  ecosystemFundIsContract: boolean;
  buybackWalletIsContract: boolean;
  buybackReserve: bigint;
  pendingBuybackTaxTokens: bigint;
  pendingEcosystemTaxTokens: bigint;
  pendingSellBurnTokens: bigint;
};

type TreasuryForm = {
  reserveBnbAmount: string;
  dividendBnbAmount: string;
  dividendTokenAmount: string;
  ecosystemBnbAmount: string;
  ecosystemTokenAmount: string;
  buybackBnbAmount: string;
  buybackTokenAmount: string;
};

type VaultTarget = "dividend" | "ecosystem" | "buyback";
type VaultAsset = "bnb" | "token";

type TreasuryRow = {
  key: keyof TreasuryForm;
  title: string;
  source: string;
  asset: string;
  available: string;
  onSubmit: () => void;
  busy: boolean;
  disabled: boolean;
};

const initialRuntime: RuntimeConfig = {
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL ?? "",
  chainId: process.env.NEXT_PUBLIC_CHAIN_ID ?? "56",
  managerAddress: process.env.NEXT_PUBLIC_MANAGER_ADDRESS ?? "",
  tokenAddress: process.env.NEXT_PUBLIC_TOKEN_ADDRESS ?? "",
};

const initialTreasuryForm: TreasuryForm = {
  reserveBnbAmount: "0.1",
  dividendBnbAmount: "0.1",
  dividendTokenAmount: "1000",
  ecosystemBnbAmount: "0.1",
  ecosystemTokenAmount: "1000",
  buybackBnbAmount: "0.1",
  buybackTokenAmount: "1000",
};

const actionWarnings: Record<string, string> = {
  setOperationMode: "确认切换运行模式？",
  setBuyEnabled: "确认修改买入开关？",
  syncSystemState: "确认同步系统状态？",
  processTaxRevenue: "确认处理待结税收？",
  executeDeflation: "确认立即执行通缩？",
  executeBuyback: "确认立即执行回购？",
  withdrawBuybackReserve: "确认提取回购储备？",
  withdrawVaultBNB: "确认提取金库 BNB？",
  withdrawVaultToken: "确认提取金库 Token？",
};

function getProvider() {
  if (typeof window === "undefined") {
    return null;
  }

  return ((window as typeof window & { ethereum?: EthereumProvider }).ethereum ?? null);
}

function normalizeAddress(value: string) {
  return value.trim() as Address;
}

function parseAmount(value: string, label: string) {
  try {
    return parseEther(value);
  } catch {
    throw new Error(`${label} 数值无效`);
  }
}

function networkLabel(chainId: number) {
  return chainId === 97 ? "BSC 测试网" : "BSC 主网";
}

function confirmAction(name: string) {
  const warning = actionWarnings[name];
  if (!warning || typeof window === "undefined") {
    return true;
  }

  return window.confirm(warning);
}

function Card({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-4">
      <div className="text-xs text-white/45">{title}</div>
      <div className="mt-2 text-lg font-semibold text-white">{value}</div>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[28px] border border-white/10 bg-white/[0.03] p-5 md:p-6">
      <h2 className="mb-4 text-xl font-semibold text-white">{title}</h2>
      {children}
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-sm text-white/60">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white outline-none placeholder:text-white/25 disabled:cursor-not-allowed disabled:opacity-70"
      />
    </label>
  );
}

function TreasuryRowCard({
  title,
  source,
  asset,
  available,
  amount,
  onAmountChange,
  onSubmit,
  busy,
  disabled,
  owner,
}: {
  title: string;
  source: string;
  asset: string;
  available: string;
  amount: string;
  onAmountChange: (value: string) => void;
  onSubmit: () => void;
  busy: boolean;
  disabled: boolean;
  owner: string;
}) {
  return (
    <div className="rounded-3xl border border-white/10 bg-black/20 p-4">
      <div className="grid gap-4 lg:grid-cols-[1.2fr,0.8fr]">
        <div className="space-y-1">
          <div className="text-sm font-medium text-white">{title}</div>
          <div className="text-xs text-white/45">来源: {source}</div>
          <div className="text-xs text-white/45">币种: {asset}</div>
          <div className="text-xs text-white/45">可提余额: {available}</div>
          <div className="text-xs text-white/45 break-all">到账地址: {owner}</div>
        </div>
        <div className="space-y-3">
          <Field label="提取数量" value={amount} onChange={onAmountChange} />
          <button
            type="button"
            onClick={onSubmit}
            disabled={busy || disabled}
            className="w-full rounded-2xl bg-[#f5c842] px-4 py-3 text-sm font-medium text-black transition hover:bg-[#ffd560] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "处理中..." : "提取"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ActionButton({
  children,
  onClick,
  busy,
  disabled,
  tone = "primary",
}: {
  children: React.ReactNode;
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
  tone?: "primary" | "secondary";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      className={`rounded-2xl px-4 py-3 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${
        tone === "primary"
          ? "bg-[#f5c842] text-black hover:bg-[#ffd560]"
          : "border border-white/10 bg-white/5 text-white hover:bg-white/10"
      }`}
    >
      {busy ? "处理中..." : children}
    </button>
  );
}

export default function AdminDashboard() {
  const [runtime] = useState(initialRuntime);
  const [account, setAccount] = useState<Address | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [status, setStatus] = useState("连接 owner 钱包后操作");
  const [modeForm, setModeForm] = useState({ operationMode: "0", buyEnabled: false });
  const [treasuryForm, setTreasuryForm] = useState(initialTreasuryForm);

  const targetChainId = useMemo(() => Number(runtime.chainId || "56"), [runtime.chainId]);
  const configReady = Boolean(runtime.rpcUrl && isAddress(runtime.managerAddress) && isAddress(runtime.tokenAddress));

  const publicClient = useMemo(() => {
    if (!runtime.rpcUrl) {
      return null;
    }

    const chain = targetChainId === 97 ? bscTestnet : bsc;
    return createPublicClient({ chain, transport: http(runtime.rpcUrl) });
  }, [runtime.rpcUrl, targetChainId]);

  useEffect(() => {
    if (configReady) {
      void refreshSnapshot();
    }
  }, [configReady]);

  async function connectWallet() {
    try {
      const provider = getProvider();
      if (!provider) {
        throw new Error("未检测到浏览器钱包");
      }

      const requested = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      const currentChainHex = (await provider.request({ method: "eth_chainId" })) as string;
      const currentChainId = Number.parseInt(currentChainHex, 16);

      if (currentChainId !== targetChainId) {
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: `0x${targetChainId.toString(16)}` }],
        });
      }

      setAccount(normalizeAddress(requested[0]));
      setStatus(`已连接 ${shortAddress(requested[0])}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "连接失败");
    }
  }

  async function refreshSnapshot() {
    try {
      if (!configReady || !publicClient) {
        throw new Error("后台未配置");
      }

      setBusyAction("refresh");

      const managerAddress = normalizeAddress(runtime.managerAddress);
      const tokenAddress = normalizeAddress(runtime.tokenAddress);
      const dividendPool = await publicClient.readContract({ address: managerAddress, abi: managerAbi, functionName: "dividendPool" });
      const ecosystemFund = await publicClient.readContract({ address: managerAddress, abi: managerAbi, functionName: "ecosystemFund" });
      const buybackWallet = await publicClient.readContract({ address: managerAddress, abi: managerAbi, functionName: "buybackWallet" });

      const [
        managerOwner,
        operationMode,
        buyEnabled,
        dividendPoolBnbBalance,
        ecosystemFundBnbBalance,
        buybackWalletBnbBalance,
        dividendPoolTokenBalance,
        ecosystemFundTokenBalance,
        buybackWalletTokenBalance,
        dividendPoolBytecode,
        ecosystemFundBytecode,
        buybackWalletBytecode,
        buybackReserve,
        pendingBuybackTaxTokens,
        pendingEcosystemTaxTokens,
        pendingSellBurnTokens,
      ] = await Promise.all([
        publicClient.readContract({ address: managerAddress, abi: managerAbi, functionName: "owner" }),
        publicClient.readContract({ address: managerAddress, abi: managerAbi, functionName: "operationMode" }),
        publicClient.readContract({ address: managerAddress, abi: managerAbi, functionName: "buyEnabled" }),
        publicClient.getBalance({ address: dividendPool }),
        publicClient.getBalance({ address: ecosystemFund }),
        publicClient.getBalance({ address: buybackWallet }),
        publicClient.readContract({ address: tokenAddress, abi: tokenAbi, functionName: "balanceOf", args: [dividendPool] }),
        publicClient.readContract({ address: tokenAddress, abi: tokenAbi, functionName: "balanceOf", args: [ecosystemFund] }),
        publicClient.readContract({ address: tokenAddress, abi: tokenAbi, functionName: "balanceOf", args: [buybackWallet] }),
        publicClient.getBytecode({ address: dividendPool }),
        publicClient.getBytecode({ address: ecosystemFund }),
        publicClient.getBytecode({ address: buybackWallet }),
        publicClient.readContract({ address: tokenAddress, abi: tokenAbi, functionName: "buybackReserve" }),
        publicClient.readContract({ address: tokenAddress, abi: tokenAbi, functionName: "pendingBuybackTaxTokens" }),
        publicClient.readContract({ address: tokenAddress, abi: tokenAbi, functionName: "pendingEcosystemTaxTokens" }),
        publicClient.readContract({ address: tokenAddress, abi: tokenAbi, functionName: "pendingSellBurnTokens" }),
      ]);

      const nextSnapshot: Snapshot = {
        managerOwner,
        operationMode: Number(operationMode),
        buyEnabled,
        dividendPool,
        ecosystemFund,
        buybackWallet,
        dividendPoolBnbBalance,
        ecosystemFundBnbBalance,
        buybackWalletBnbBalance,
        dividendPoolTokenBalance,
        ecosystemFundTokenBalance,
        buybackWalletTokenBalance,
        dividendPoolIsContract: Boolean(dividendPoolBytecode),
        ecosystemFundIsContract: Boolean(ecosystemFundBytecode),
        buybackWalletIsContract: Boolean(buybackWalletBytecode),
        buybackReserve,
        pendingBuybackTaxTokens,
        pendingEcosystemTaxTokens,
        pendingSellBurnTokens,
      };

      setSnapshot(nextSnapshot);
      setModeForm({ operationMode: String(nextSnapshot.operationMode), buyEnabled: nextSnapshot.buyEnabled });
      setStatus("状态已刷新");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "读取失败");
    } finally {
      setBusyAction(null);
    }
  }

  async function writeContractWithAbi(
    address: Address,
    abi: typeof managerAbi | typeof tokenAbi | typeof treasuryVaultAbi,
    functionName: string,
    args: unknown[]
  ) {
    try {
      const provider = getProvider();
      if (!provider) {
        throw new Error("未检测到浏览器钱包");
      }
      if (!account) {
        throw new Error("请先连接钱包");
      }
      if (!publicClient) {
        throw new Error("后台未配置");
      }

      const walletChain = targetChainId === 97 ? bscTestnet : bsc;
      const walletClient = createWalletClient({
        account,
        chain: walletChain,
        transport: custom(provider),
      });

      setBusyAction(functionName);
      const hash = (await walletClient.writeContract({
        address,
        abi,
        functionName: functionName as never,
        args: args as never,
        account,
      })) as Hash;

      setStatus(`已提交 ${hash.slice(0, 10)}...`);
      await publicClient.waitForTransactionReceipt({ hash });
      await refreshSnapshot();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : `${functionName} 失败`);
    } finally {
      setBusyAction(null);
    }
  }

  async function writeManager(functionName: string, args: unknown[] = []) {
    await writeContractWithAbi(normalizeAddress(runtime.managerAddress), managerAbi, functionName, args);
  }

  async function writeToken(functionName: string, args: unknown[] = []) {
    await writeContractWithAbi(normalizeAddress(runtime.tokenAddress), tokenAbi, functionName, args);
  }

  async function writeVault(address: Address, functionName: string, args: unknown[]) {
    await writeContractWithAbi(address, treasuryVaultAbi, functionName, args);
  }

  async function submitSwitches() {
    if (!confirmAction("setOperationMode") || !confirmAction("setBuyEnabled")) return;
    await writeManager("setOperationMode", [Number(modeForm.operationMode)]);
    await writeManager("setBuyEnabled", [modeForm.buyEnabled]);
  }

  function runQuickAction(functionName: string) {
    if (!confirmAction(functionName)) return;
    void writeToken(functionName);
  }

  function ensureWithinBalance(amount: bigint, available: bigint, label: string) {
    if (amount <= BigInt(0)) {
      throw new Error(`${label} 数量必须大于 0`);
    }
    if (amount > available) {
      throw new Error(`${label} 超过可提余额`);
    }
  }

  async function withdrawBuybackReserve() {
    if (!snapshot) {
      return;
    }

    if (!confirmAction("withdrawBuybackReserve")) return;
    const amount = parseAmount(treasuryForm.reserveBnbAmount, "回购储备");
    ensureWithinBalance(amount, snapshot.buybackReserve, "回购储备");
    await writeToken("withdrawBuybackReserve", [snapshot.managerOwner, amount]);
  }

  function getVaultConfig(target: VaultTarget, currentSnapshot: Snapshot) {
    if (target === "dividend") {
      return {
        address: currentSnapshot.dividendPool,
        isContract: currentSnapshot.dividendPoolIsContract,
        bnbBalance: currentSnapshot.dividendPoolBnbBalance,
        tokenBalance: currentSnapshot.dividendPoolTokenBalance,
      };
    }

    if (target === "ecosystem") {
      return {
        address: currentSnapshot.ecosystemFund,
        isContract: currentSnapshot.ecosystemFundIsContract,
        bnbBalance: currentSnapshot.ecosystemFundBnbBalance,
        tokenBalance: currentSnapshot.ecosystemFundTokenBalance,
      };
    }

    return {
      address: currentSnapshot.buybackWallet,
      isContract: currentSnapshot.buybackWalletIsContract,
      bnbBalance: currentSnapshot.buybackWalletBnbBalance,
      tokenBalance: currentSnapshot.buybackWalletTokenBalance,
    };
  }

  async function handleVaultAction(target: VaultTarget, asset: VaultAsset, amountInput: string) {
    if (!snapshot) {
      return;
    }

    const vault = getVaultConfig(target, snapshot);
    if (!vault.isContract) {
      setStatus("当前资金池不是系统金库，不能从后台直接提取");
      return;
    }

    const amount = parseAmount(amountInput, asset === "bnb" ? "BNB" : "Token");

    if (asset === "bnb") {
      ensureWithinBalance(amount, vault.bnbBalance, "BNB");
      if (!confirmAction("withdrawVaultBNB")) return;
      await writeVault(vault.address, "withdrawBNB", [snapshot.managerOwner, amount]);
      return;
    }

    ensureWithinBalance(amount, vault.tokenBalance, "Token");
    if (!confirmAction("withdrawVaultToken")) return;
    await writeVault(vault.address, "withdrawToken", [normalizeAddress(runtime.tokenAddress), snapshot.managerOwner, amount]);
  }

  const canManage = snapshot && account
    ? snapshot.managerOwner.toLowerCase() === account.toLowerCase()
    : false;

  const controlsLocked = !account || !canManage;
  const treasuryRows: TreasuryRow[] = snapshot
    ? [
        {
          key: "reserveBnbAmount",
          title: "回购储备",
          source: "主合约内部储备",
          asset: "BNB",
          available: formatBnb(snapshot.buybackReserve),
          onSubmit: () => void withdrawBuybackReserve(),
          busy: busyAction === "withdrawBuybackReserve",
          disabled: controlsLocked,
        },
        {
          key: "dividendBnbAmount",
          title: "分红池 BNB",
          source: "分红池金库",
          asset: "BNB",
          available: formatBnb(snapshot.dividendPoolBnbBalance),
          onSubmit: () => void handleVaultAction("dividend", "bnb", treasuryForm.dividendBnbAmount),
          busy: busyAction === "withdrawBNB",
          disabled: controlsLocked || !snapshot.dividendPoolIsContract,
        },
        {
          key: "dividendTokenAmount",
          title: "分红池 Token",
          source: "分红池金库",
          asset: "USCAMEX",
          available: `${formatToken(snapshot.dividendPoolTokenBalance)} USCAMEX`,
          onSubmit: () => void handleVaultAction("dividend", "token", treasuryForm.dividendTokenAmount),
          busy: busyAction === "withdrawToken",
          disabled: controlsLocked || !snapshot.dividendPoolIsContract,
        },
        {
          key: "ecosystemBnbAmount",
          title: "生态池 BNB",
          source: "生态池金库",
          asset: "BNB",
          available: formatBnb(snapshot.ecosystemFundBnbBalance),
          onSubmit: () => void handleVaultAction("ecosystem", "bnb", treasuryForm.ecosystemBnbAmount),
          busy: busyAction === "withdrawBNB",
          disabled: controlsLocked || !snapshot.ecosystemFundIsContract,
        },
        {
          key: "ecosystemTokenAmount",
          title: "生态池 Token",
          source: "生态池金库",
          asset: "USCAMEX",
          available: `${formatToken(snapshot.ecosystemFundTokenBalance)} USCAMEX`,
          onSubmit: () => void handleVaultAction("ecosystem", "token", treasuryForm.ecosystemTokenAmount),
          busy: busyAction === "withdrawToken",
          disabled: controlsLocked || !snapshot.ecosystemFundIsContract,
        },
        {
          key: "buybackBnbAmount",
          title: "回购池 BNB",
          source: "回购池金库",
          asset: "BNB",
          available: formatBnb(snapshot.buybackWalletBnbBalance),
          onSubmit: () => void handleVaultAction("buyback", "bnb", treasuryForm.buybackBnbAmount),
          busy: busyAction === "withdrawBNB",
          disabled: controlsLocked || !snapshot.buybackWalletIsContract,
        },
        {
          key: "buybackTokenAmount",
          title: "回购池 Token",
          source: "回购池金库",
          asset: "USCAMEX",
          available: `${formatToken(snapshot.buybackWalletTokenBalance)} USCAMEX`,
          onSubmit: () => void handleVaultAction("buyback", "token", treasuryForm.buybackTokenAmount),
          busy: busyAction === "withdrawToken",
          disabled: controlsLocked || !snapshot.buybackWalletIsContract,
        },
      ]
    : [];

  return (
    <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-6 px-4 py-8 md:px-8 md:py-10">
      <section className="rounded-[32px] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.06),rgba(255,255,255,0.02))] p-6 md:p-8">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-xs uppercase tracking-[0.2em] text-[#f5c842]">USCAMEX</div>
            <h1 className="mt-2 text-3xl font-semibold text-white">管理后台</h1>
          </div>
          <div className="flex flex-wrap gap-3">
            <ActionButton onClick={connectWallet} busy={busyAction === "connect"}>连接钱包</ActionButton>
            <ActionButton onClick={() => void refreshSnapshot()} busy={busyAction === "refresh"} disabled={!configReady} tone="secondary">刷新状态</ActionButton>
          </div>
        </div>
        <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white/70">
          {status}
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card title="网络" value={networkLabel(targetChainId)} />
        <Card title="钱包" value={account ? shortAddress(account) : "未连接"} />
        <Card title="模式" value={snapshot ? modeLabel(snapshot.operationMode) : "未读取"} />
        <Card title="回购储备" value={snapshot ? formatBnb(snapshot.buybackReserve) : "未读取"} />
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Block title="状态">
          {snapshot ? (
            <div className="grid gap-3 text-sm text-white/75">
              <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3">Owner: {shortAddress(snapshot.managerOwner)}</div>
              <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3">买入: {snapshot.buyEnabled ? "开启" : "关闭"}</div>
              <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3">分红池: {formatBnb(snapshot.dividendPoolBnbBalance)} / {formatToken(snapshot.dividendPoolTokenBalance)} USCAMEX</div>
              <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3">生态池: {formatBnb(snapshot.ecosystemFundBnbBalance)} / {formatToken(snapshot.ecosystemFundTokenBalance)} USCAMEX</div>
              <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3">回购池: {formatBnb(snapshot.buybackWalletBnbBalance)} / {formatToken(snapshot.buybackWalletTokenBalance)} USCAMEX</div>
              <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3">待结税: {formatToken(snapshot.pendingBuybackTaxTokens + snapshot.pendingEcosystemTaxTokens)} USCAMEX</div>
              <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3">待销毁: {formatToken(snapshot.pendingSellBurnTokens)} USCAMEX</div>
            </div>
          ) : (
            <div className="text-sm text-white/55">先刷新状态</div>
          )}
        </Block>

        <Block title="开关">
          <div className="grid gap-4">
            <label className="flex flex-col gap-2">
              <span className="text-sm text-white/60">运行模式</span>
              <select
                value={modeForm.operationMode}
                onChange={(event) => setModeForm((current) => ({ ...current, operationMode: event.target.value }))}
                className="rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white outline-none"
              >
                <option value="0">节点销售</option>
                <option value="1">开放入金</option>
              </select>
            </label>
            <label className="flex items-center justify-between rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white/75">
              <span>允许买入</span>
              <input
                type="checkbox"
                checked={modeForm.buyEnabled}
                onChange={(event) => setModeForm((current) => ({ ...current, buyEnabled: event.target.checked }))}
              />
            </label>
            <ActionButton onClick={() => void submitSwitches()} busy={busyAction === "setOperationMode" || busyAction === "setBuyEnabled"} disabled={controlsLocked}>提交</ActionButton>
          </div>
        </Block>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Block title="操作">
          <div className="grid gap-3 sm:grid-cols-2">
            <ActionButton onClick={() => runQuickAction("syncSystemState")} busy={busyAction === "syncSystemState"} disabled={controlsLocked}>同步</ActionButton>
            <ActionButton onClick={() => runQuickAction("processTaxRevenue")} busy={busyAction === "processTaxRevenue"} disabled={controlsLocked}>结税</ActionButton>
            <ActionButton onClick={() => runQuickAction("executeDeflation")} busy={busyAction === "executeDeflation"} disabled={controlsLocked}>通缩</ActionButton>
            <ActionButton onClick={() => runQuickAction("executeBuyback")} busy={busyAction === "executeBuyback"} disabled={controlsLocked}>回购</ActionButton>
          </div>
        </Block>

        <Block title="提资金">
          {snapshot ? (
            <div className="grid gap-4">
              <Field label="默认到账管理员地址" value={snapshot.managerOwner} disabled />
              {treasuryRows.map((row) => (
                <TreasuryRowCard
                  key={row.key}
                  title={row.title}
                  source={row.source}
                  asset={row.asset}
                  available={row.available}
                  amount={treasuryForm[row.key]}
                  onAmountChange={(value) => setTreasuryForm((current) => ({ ...current, [row.key]: value }))}
                  onSubmit={row.onSubmit}
                  busy={row.busy}
                  disabled={row.disabled}
                  owner={snapshot.managerOwner}
                />
              ))}
            </div>
          ) : (
            <div className="text-sm text-white/55">先刷新状态</div>
          )}
        </Block>
      </div>
    </div>
  );
}
