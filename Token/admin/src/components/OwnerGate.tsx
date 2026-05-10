import { Alert, Button, Space } from "antd";
import { useWallet } from "../hooks/useWallet";

export default function OwnerGate({ children }: { children: React.ReactNode }) {
  const wallet = useWallet();
  if (!wallet.account) {
    return (
      <Alert
        type="warning"
        showIcon
        message="请先连接 Owner 钱包"
        description="数据查询面板需要 Owner 钱包对消息签名后才能调用后端 API。"
        action={
          <Space>
            <Button type="primary" onClick={() => wallet.connect()} loading={wallet.connecting}>
              连接钱包
            </Button>
          </Space>
        }
      />
    );
  }
  if (!wallet.authorized) {
    return (
      <Alert
        type="info"
        showIcon
        message="请用 Owner 钱包签名授权"
        description="后端会校验签名是否对应链上 owner，签名仅在浏览器内存中保存。"
        action={
          <Button type="primary" onClick={() => wallet.authorize()}>
            签名授权
          </Button>
        }
      />
    );
  }
  return <>{children}</>;
}
