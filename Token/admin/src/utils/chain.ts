import { BrowserProvider, JsonRpcProvider, verifyMessage, type Eip1193Provider } from "ethers";
import { loadSettings } from "./settings";

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
  const provider = getInjectedProvider();
  const signer = await provider.getSigner(fromAddress);
  const settings = loadSettings();
  const tx = await signer.sendTransaction({ to: settings.tokenAddress, data });
  return tx.hash;
}

export async function signOwnerMessage(account: string): Promise<{ message: string; signature: string }> {
  const provider = getInjectedProvider();
  const signer = await provider.getSigner(account);
  const settings = loadSettings();
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
