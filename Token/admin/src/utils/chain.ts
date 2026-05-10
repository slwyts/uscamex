import { BrowserProvider, JsonRpcProvider, type Eip1193Provider } from "ethers";
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
  return { message, signature };
}
