import { Alert, Button, Space } from "antd";
import { useWallet } from "../hooks/useWallet";

export default function OwnerGate({ children }: { children: React.ReactNode }) {
  const wallet = useWallet();
  if (!wallet.account) {
    return (
      <Alert
        type="warning"
        showIcon
        message="请连接管理员钱包"
        description="本页内容受权限保护，需要使用合约管理员（Owner）的钱包进行签名后方可查看。"
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
        message="请使用管理员钱包完成签名"
        description="系统会通过签名校验当前钱包是否为合约管理员；签名仅在当前浏览器内存中暂存，不会上链、不消耗 gas。"
        action={
          <Button type="primary" onClick={() => wallet.authorize()}>
            进行签名
          </Button>
        }
      />
    );
  }
  return <>{children}</>;
}
