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
import { setAdminAuth, clearAdminAuth, hasAdminAuth } from "../utils/api";

interface WalletState {
  account: string;
  authorized: boolean;
  connecting: boolean;
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
  });

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
    const auth = await signOwnerMessage(account);
    setAdminAuth(auth.message, auth.signature);
    setState((prev) => ({ ...prev, authorized: true }));
    message.success("已签名授权，可以读取后端数据");
  }, [connect, state.account, message]);

  const disconnect = useCallback(() => {
    clearAdminAuth();
    setState({ account: "", authorized: false, connecting: false });
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
        setState({ account: "", authorized: false, connecting: false });
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
