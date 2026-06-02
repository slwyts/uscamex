import { BrowserProvider, JsonRpcProvider, verifyMessage, type Eip1193Provider } from "ethers";
import { bootstrapSettingsFromBackend, loadSettings, type OperatorSettings } from "./settings";

declare global {
  interface Window {
    ethereum?: Eip1193Provider & { on?: (event: string, handler: (...args: unknown[]) => void) => void };
  }
}

export function getInjectedProvider(): BrowserProvider {
  if (!window.ethereum) throw new Error("未检测到钱包，请安装并启用 EVM 钱包");
  return new BrowserProvider(window.ethereum);
}

export function getReadProvider(): JsonRpcProvider {
  const settings = loadSettings();
  return new JsonRpcProvider(settings.rpcUrl, settings.chainId);
}

interface AddEthereumChainParams {
  chainId: string;
  chainName: string;
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
  rpcUrls: string[];
  blockExplorerUrls?: string[];
}

interface ProviderRpcError extends Error {
  code?: number | string;
}

export function chainIdHex(chainId: number): string {
  return `0x${chainId.toString(16)}`;
}

export function chainDisplayName(chainId: number): string {
  if (chainId === 56) return "BSC 主网";
  if (chainId === 97) return "BSC 测试网";
  return `链 ${chainId}`;
}

function addChainParams(settings: OperatorSettings): AddEthereumChainParams {
  if (settings.chainId === 56) {
    return {
      chainId: chainIdHex(56),
      chainName: "BNB Smart Chain",
      nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
      rpcUrls: [settings.rpcUrl || "https://bsc-dataseed.binance.org"],
      blockExplorerUrls: ["https://bscscan.com"],
    };
  }
  if (settings.chainId === 97) {
    return {
      chainId: chainIdHex(97),
      chainName: "BNB Smart Chain Testnet",
      nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 },
      rpcUrls: [settings.rpcUrl || "https://bsc-testnet-rpc.publicnode.com"],
      blockExplorerUrls: ["https://testnet.bscscan.com"],
    };
  }
  return {
    chainId: chainIdHex(settings.chainId),
    chainName: chainDisplayName(settings.chainId),
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: [settings.rpcUrl],
  };
}

function isUnknownChainError(error: unknown): boolean {
  const code = (error as ProviderRpcError | undefined)?.code;
  return code === 4902 || code === "4902";
}

function switchRejectedMessage(settings: OperatorSettings): string {
  return `请在钱包中切换到${chainDisplayName(settings.chainId)}（chainId ${settings.chainId}）后再继续`;
}

export async function getWalletChainId(): Promise<number> {
  const provider = getInjectedProvider();
  const chainId = await provider.send("eth_chainId", []);
  if (typeof chainId === "string") return Number.parseInt(chainId, 16);
  return Number(chainId);
}

export async function ensureWalletChain(settings?: OperatorSettings): Promise<void> {
  if (!settings) {
    await bootstrapSettingsFromBackend().catch(() => undefined);
    settings = loadSettings();
  }
  if (!Number.isInteger(settings.chainId) || settings.chainId <= 0) {
    throw new Error("链 ID 配置不正确，请先在【连接设置】中填写正确的链 ID");
  }
  const provider = getInjectedProvider();
  const expected = chainIdHex(settings.chainId);
  const current = await getWalletChainId();
  if (current === settings.chainId) return;

  try {
    await provider.send("wallet_switchEthereumChain", [{ chainId: expected }]);
  } catch (error) {
    if (!isUnknownChainError(error)) {
      throw new Error(switchRejectedMessage(settings));
    }
    try {
      await provider.send("wallet_addEthereumChain", [addChainParams(settings)]);
      await provider.send("wallet_switchEthereumChain", [{ chainId: expected }]);
    } catch {
      throw new Error(switchRejectedMessage(settings));
    }
  }

  const next = await getWalletChainId();
  if (next !== settings.chainId) {
    throw new Error(switchRejectedMessage(settings));
  }
}

export async function ethCall(data: string): Promise<string> {
  const settings = loadSettings();
  const provider = getReadProvider();
  return provider.call({ to: settings.tokenAddress, data });
}

export async function ethCallTo(to: string, data: string): Promise<string> {
  const provider = getReadProvider();
  return provider.call({ to, data });
}

export async function getNativeBalance(address: string): Promise<bigint> {
  const provider = getReadProvider();
  return provider.getBalance(address);
}

export async function sendTokenTransaction(data: string, fromAddress: string): Promise<string> {
  await ensureWalletChain();
  const settings = loadSettings();
  const provider = getInjectedProvider();
  const signer = await provider.getSigner(fromAddress);
  const tx = await signer.sendTransaction({ to: settings.tokenAddress, data });
  return tx.hash;
}

export async function signOwnerMessage(account: string): Promise<{ message: string; signature: string }> {
  await ensureWalletChain();
  const settings = loadSettings();
  const provider = getInjectedProvider();
  const signer = await provider.getSigner(account);
  if (!/^0x[0-9a-fA-F]{40}$/.test(settings.tokenAddress)) {
    throw new Error("未读取到合约地址，请先在【连接设置】里填写或等待自动同步完成");
  }
  const message = [
    "USCAMEX Admin",
    `address=${account.toLowerCase()}`,
    `token=${settings.tokenAddress.toLowerCase()}`,
    `chainId=${settings.chainId}`,
    `timestamp=${Math.floor(Date.now() / 1000)}`,
  ].join("\n");
  const signature = await signer.signMessage(message);
  // Some wallets (especially mobile in-DApp browsers) sign with the *currently
  // active* account in the wallet, ignoring the address we requested. Verify
  // locally so we fail fast instead of producing a 403 after the fact.
  const recovered = verifyMessage(message, signature).toLowerCase();
  if (recovered !== account.toLowerCase()) {
    throw new Error(
      `钱包返回的签名地址 ${recovered} 与请求地址 ${account.toLowerCase()} 不一致，请在钱包内切换到目标账户后重试`,
    );
  }
  return { message, signature };
}
