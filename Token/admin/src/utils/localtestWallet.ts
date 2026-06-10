import { JsonRpcProvider, Wallet, getBytes, isHexString, type Eip1193Provider } from "ethers";

interface LocaltestAccount {
  index: number;
  address: string;
  privateKey: string;
}

interface LocaltestWalletConfig {
  chainId: number;
  rpcUrl: string;
  accounts: LocaltestAccount[];
}

type Listener = (...args: unknown[]) => void;

interface RpcRequest {
  method: string;
  params?: unknown[] | Record<string, unknown>;
}

interface TxRequest {
  from?: string;
  to?: string;
  data?: string;
  value?: string;
  gas?: string;
  gasLimit?: string;
  gasPrice?: string;
  nonce?: string;
}

declare global {
  interface Window {
    __USCAMEX_LOCALTEST_WALLET__?: LocaltestWalletConfig;
    uscamexLocaltestWallet?: {
      accounts: LocaltestAccount[];
      currentAccount: () => string;
      useAccount: (index: number) => string;
    };
  }
}

class LocaltestProvider implements Eip1193Provider {
  private readonly rpcProvider: JsonRpcProvider;
  private readonly wallets = new Map<string, Wallet>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private selectedIndex = 0;

  constructor(private readonly config: LocaltestWalletConfig) {
    this.rpcProvider = new JsonRpcProvider(config.rpcUrl, config.chainId);
    for (const account of config.accounts) {
      this.wallets.set(account.address.toLowerCase(), new Wallet(account.privateKey, this.rpcProvider));
    }
  }

  async request(request: RpcRequest): Promise<unknown> {
    const params = arrayParams(request.params);
    switch (request.method) {
      case "eth_chainId":
        return hex(this.config.chainId);
      case "net_version":
        return String(this.config.chainId);
      case "eth_accounts":
      case "eth_requestAccounts":
        return [this.currentAccount()];
      case "wallet_switchEthereumChain":
        this.assertChain(params[0]);
        return null;
      case "wallet_addEthereumChain":
        return null;
      case "personal_sign":
        return this.personalSign(params);
      case "eth_sign":
        return this.ethSign(params);
      case "eth_sendTransaction":
        return this.sendTransaction(params[0]);
      default:
        return this.rpc(request.method, params);
    }
  }

  on(event: string, listener: Listener): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return this;
  }

  removeListener(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  currentAccount(): string {
    return this.config.accounts[this.selectedIndex].address.toLowerCase();
  }

  useAccount(index: number): string {
    const next = Math.max(0, Math.min(this.config.accounts.length - 1, index));
    this.selectedIndex = next;
    const account = this.currentAccount();
    this.emit("accountsChanged", [account]);
    return account;
  }

  private async personalSign(params: unknown[]): Promise<string> {
    const message = String(params[0] ?? "");
    const address = typeof params[1] === "string" ? params[1] : this.currentAccount();
    return this.walletFor(address).signMessage(messagePayload(message));
  }

  private async ethSign(params: unknown[]): Promise<string> {
    const address = typeof params[0] === "string" ? params[0] : this.currentAccount();
    const message = String(params[1] ?? "");
    return this.walletFor(address).signMessage(messagePayload(message));
  }

  private async sendTransaction(raw: unknown): Promise<string> {
    const tx = (raw ?? {}) as TxRequest;
    const wallet = this.walletFor(tx.from);
    const sent = await wallet.sendTransaction({
      to: tx.to,
      data: tx.data ?? "0x",
      value: tx.value ? BigInt(tx.value) : undefined,
      gasLimit: tx.gasLimit ? BigInt(tx.gasLimit) : tx.gas ? BigInt(tx.gas) : undefined,
      gasPrice: tx.gasPrice ? BigInt(tx.gasPrice) : undefined,
      nonce: tx.nonce ? Number(BigInt(tx.nonce)) : undefined,
    });
    return sent.hash;
  }

  private walletFor(address?: string): Wallet {
    const normalized = (address || this.currentAccount()).toLowerCase();
    const wallet = this.wallets.get(normalized);
    if (!wallet) throw new Error(`localtest wallet does not control ${normalized}`);
    return wallet;
  }

  private assertChain(raw: unknown): void {
    const requested = (raw as { chainId?: unknown } | undefined)?.chainId;
    if (typeof requested !== "string") return;
    if (Number.parseInt(requested, 16) !== this.config.chainId) {
      throw Object.assign(new Error(`Unsupported chain ${requested}`), { code: 4902 });
    }
  }

  private async rpc(method: string, params: unknown[]): Promise<unknown> {
    const res = await fetch(this.config.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    });
    const body = (await res.json()) as { result?: unknown; error?: { message?: string; code?: number } };
    if (body.error) throw Object.assign(new Error(body.error.message || "RPC error"), { code: body.error.code });
    return body.result;
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

export function installLocaltestWallet(): void {
  const config = window.__USCAMEX_LOCALTEST_WALLET__;
  if (!config || config.accounts.length === 0) return;
  const provider = new LocaltestProvider(config);
  window.ethereum = provider as Eip1193Provider & {
    on: (event: string, handler: Listener) => unknown;
    removeListener: (event: string, handler: Listener) => unknown;
  };
  window.uscamexLocaltestWallet = {
    accounts: config.accounts,
    currentAccount: () => provider.currentAccount(),
    useAccount: (index) => provider.useAccount(index - 1),
  };
  mountSwitcher(config, provider);
}

function mountSwitcher(config: LocaltestWalletConfig, provider: LocaltestProvider): void {
  const mount = () => {
    const wrap = document.createElement("div");
    wrap.style.cssText = [
      "position:fixed",
      "right:12px",
      "bottom:12px",
      "z-index:2147483647",
      "background:#121212",
      "color:#ffd700",
      "border:1px solid rgba(255,215,0,.45)",
      "border-radius:10px",
      "padding:8px",
      "font:12px system-ui,sans-serif",
      "box-shadow:0 8px 28px rgba(0,0,0,.45)",
    ].join(";");
    const label = document.createElement("div");
    label.textContent = "Localtest wallet";
    label.style.marginBottom = "6px";
    const select = document.createElement("select");
    select.style.cssText = "max-width:260px;background:#1f1f1f;color:#fff;border:1px solid #555;border-radius:6px;padding:4px";
    for (const account of config.accounts) {
      const option = document.createElement("option");
      option.value = String(account.index);
      option.textContent = `#${account.index} ${short(account.address)}${account.index === 1 ? " owner" : account.index === 20 ? " op" : ""}`;
      select.appendChild(option);
    }
    select.addEventListener("change", () => provider.useAccount(Number(select.value) - 1));
    wrap.append(label, select);
    document.body.appendChild(wrap);
  };
  if (document.body) mount();
  else window.addEventListener("DOMContentLoaded", mount, { once: true });
}

function arrayParams(params: RpcRequest["params"]): unknown[] {
  if (Array.isArray(params)) return params;
  if (params == null) return [];
  return [params];
}

function messagePayload(value: string): string | Uint8Array {
  return isHexString(value) ? getBytes(value) : value;
}

function hex(value: number): string {
  return `0x${value.toString(16)}`;
}

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
