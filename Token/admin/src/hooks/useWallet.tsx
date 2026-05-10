import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { App } from "antd";
import { getInjectedProvider, signOwnerMessage } from "../utils/chain";
import { setAdminAuth, clearAdminAuth, hasAdminAuth, fetchOwner } from "../utils/api";

interface WalletState {
  account: string;
  authorized: boolean;
  connecting: boolean;
  owner: string;
}

interface WalletContextValue extends WalletState {
  connect: () => Promise<string>;
  authorize: () => Promise<void>;
  disconnect: () => void;
  refresh: () => Promise<void>;
}

const WalletContext = createContext<WalletContextValue | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const { message } = App.useApp();
  const [state, setState] = useState<WalletState>({
    account: "",
    authorized: hasAdminAuth(),
    connecting: false,
    owner: "",
  });

  const loadOwner = useCallback(async (): Promise<string> => {
    try {
      const info = await fetchOwner();
      const owner = (info.owner || "").toLowerCase();
      setState((prev) => ({ ...prev, owner }));
      return owner;
    } catch {
      return "";
    }
  }, []);

  useEffect(() => {
    loadOwner();
  }, [loadOwner]);

  const connect = useCallback(async () => {
    if (!window.ethereum) throw new Error("未检测到钱包，请安装并启用 EVM 钱包");
    setState((prev) => ({ ...prev, connecting: true }));
    try {
      const provider = getInjectedProvider();
      const accounts = await provider.send("eth_requestAccounts", []);
      if (!accounts.length) throw new Error("钱包未返回账户");
      const account = (accounts[0] as string).toLowerCase();
      setState((prev) => ({ ...prev, account, connecting: false }));
      return account;
    } catch (error) {
      setState((prev) => ({ ...prev, connecting: false }));
      throw error;
    }
  }, []);

  const authorize = useCallback(async () => {
    let account = state.account;
    if (!account) account = await connect();
    // Pre-flight: ensure the connected wallet is the on-chain owner so we
    // don't waste a signature that the backend will reject with 403.
    let owner = state.owner;
    if (!owner) owner = await loadOwner();
    if (owner && account.toLowerCase() !== owner) {
      throw new Error(
        `当前钱包 ${account} 不是合约 owner（${owner}），请在钱包中切换到 owner 账户后重试`,
      );
    }
    const auth = await signOwnerMessage(account);
    setAdminAuth(auth.message, auth.signature);
    setState((prev) => ({ ...prev, authorized: true }));
    message.success("已签名授权，可以读取后端数据");
  }, [connect, state.account, state.owner, loadOwner, message]);

  const disconnect = useCallback(() => {
    clearAdminAuth();
    setState((prev) => ({ ...prev, account: "", authorized: false, connecting: false }));
  }, []);

  const refresh = useCallback(async () => {
    if (!window.ethereum) return;
    try {
      const provider = getInjectedProvider();
      const accounts = await provider.send("eth_accounts", []);
      if (accounts.length) {
        setState((prev) => ({ ...prev, account: (accounts[0] as string).toLowerCase() }));
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    refresh();
    if (window.ethereum?.on) {
      window.ethereum.on("accountsChanged", () => {
        clearAdminAuth();
        setState((prev) => ({ ...prev, account: "", authorized: false, connecting: false }));
      });
      window.ethereum.on("chainChanged", () => {
        clearAdminAuth();
        setState((prev) => ({ ...prev, authorized: false }));
      });
    }
  }, [refresh]);

  const value = useMemo<WalletContextValue>(
    () => ({ ...state, connect, authorize, disconnect, refresh }),
    [state, connect, authorize, disconnect, refresh],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within WalletProvider");
  return ctx;
}
