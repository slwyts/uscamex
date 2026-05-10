import { useEffect, useState } from "react";
import { Card, Descriptions, Button, Space, App, Alert, Tag, Statistic, Row, Col } from "antd";
import { ReloadOutlined, RocketOutlined } from "@ant-design/icons";
import { Interface } from "ethers";
import { useWallet } from "../hooks/useWallet";
import { ethCall, getReadProvider, sendTokenTransaction } from "../utils/chain";
import { isTokenConfigured, loadSettings } from "../utils/settings";
import { formatBnb } from "../utils/bnb";
import AddressTag from "../components/AddressTag";

const ABI = [
  "function initializeLP()",
  "function initialized() view returns (bool)",
  "function pair() view returns (address)",
  "function vault() view returns (address)",
  "function owner() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
];
const iface = new Interface(ABI);

interface Snapshot {
  initialized: boolean;
  pair: string;
  vault: string;
  owner: string;
  contractTokenBalance: bigint;
  contractBnbBalance: bigint;
}

export default function ConfigLp() {
  const { message, modal } = App.useApp();
  const wallet = useWallet();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const settings = loadSettings();

  const refresh = async () => {
    if (!isTokenConfigured(settings)) {
      message.error("请先填入合约地址");
      return;
    }
    setLoading(true);
    try {
      const provider = getReadProvider();
      const [initRet, pairRet, vaultRet, ownerRet, balRet, bnb] = await Promise.all([
        ethCall(iface.encodeFunctionData("initialized", [])),
        ethCall(iface.encodeFunctionData("pair", [])),
        ethCall(iface.encodeFunctionData("vault", [])),
        ethCall(iface.encodeFunctionData("owner", [])),
        ethCall(iface.encodeFunctionData("balanceOf", [settings.tokenAddress])),
        provider.getBalance(settings.tokenAddress),
      ]);
      const [initialized] = iface.decodeFunctionResult("initialized", initRet) as unknown as [boolean];
      const [pair] = iface.decodeFunctionResult("pair", pairRet) as unknown as [string];
      const [vault] = iface.decodeFunctionResult("vault", vaultRet) as unknown as [string];
      const [owner] = iface.decodeFunctionResult("owner", ownerRet) as unknown as [string];
      const [tokenBal] = iface.decodeFunctionResult("balanceOf", balRet) as unknown as [bigint];
      setSnap({
        initialized,
        pair: pair.toLowerCase(),
        vault: vault.toLowerCase(),
        owner: owner.toLowerCase(),
        contractTokenBalance: tokenBal,
        contractBnbBalance: bnb,
      });
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const callInit = () => {
    modal.confirm({
      title: "确认初始化流动性池？",
      content: "该操作不可撤销，合约将使用其当前持有的全部 USCAME 与 BNB 在 PancakeSwap 上建仓。请确认资金到位后再提交。",
      okText: "签名并上链",
      okButtonProps: { danger: true },
      onOk: async () => {
        if (!wallet.account) {
          message.error("请使用合约管理员钱包连接");
          return;
        }
        setSubmitting(true);
        try {
          const data = iface.encodeFunctionData("initializeLP", []);
          const tx = await sendTokenTransaction(data, wallet.account);
          message.success(`交易已提交：${tx}`);
          await refresh();
        } catch (error) {
          message.error((error as Error).message);
        } finally {
          setSubmitting(false);
        }
      },
    });
  };

  return (
    <Card
      title="流动性初始建仓与合约基础信息"
      extra={
        <Button icon={<ReloadOutlined />} onClick={refresh} loading={loading}>
          刷新
        </Button>
      }
    >
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        message="初始建仓仅能执行一次"
        description="调用前请确保合约已收到足量 BNB；初始化完成后 LP 权证将划入合约管理员，交易对 PancakeSwap 的 LP 地址也会同步写入合约。"
      />
      {snap && (
        <Space direction="vertical" size="large" style={{ width: "100%" }}>
          <Row gutter={[16, 16]}>
            <Col xs={12} md={6}>
              <Statistic title="合约持有 USCAME" value={formatBnb(snap.contractTokenBalance, 4)} />
            </Col>
            <Col xs={12} md={6}>
              <Statistic title="合约持有 BNB" value={formatBnb(snap.contractBnbBalance, 4)} />
            </Col>
            <Col xs={12} md={6}>
              <Statistic
                title="初始化状态"
                value={snap.initialized ? "已初始化" : "尚未初始化"}
                valueStyle={{ color: snap.initialized ? "#73d13d" : "#ff7875" }}
              />
            </Col>
            <Col xs={12} md={6}>
              <div style={{ color: "rgba(255,255,255,0.55)", fontSize: 12, marginBottom: 4 }}>
                当前钱包权限
              </div>
              <Tag color={snap.owner === wallet.account ? "green" : "red"}>
                {snap.owner === wallet.account ? "当前钱包为合约管理员" : "当前钱包非合约管理员"}
              </Tag>
            </Col>
          </Row>
          <Descriptions bordered column={1} size="small">
            <Descriptions.Item label="合约管理员">
              <AddressTag value={snap.owner} full />
            </Descriptions.Item>
            <Descriptions.Item label="PancakeSwap LP 地址">
              {snap.pair === "0x0000000000000000000000000000000000000000" ? (
                <Tag color="default">尚未生成（初始建仓后自动写入）</Tag>
              ) : (
                <AddressTag value={snap.pair} full />
              )}
            </Descriptions.Item>
            <Descriptions.Item label="金库合约">
              <AddressTag value={snap.vault} full />
            </Descriptions.Item>
          </Descriptions>
          <Button
            type="primary"
            danger
            icon={<RocketOutlined />}
            disabled={snap.initialized}
            loading={submitting}
            onClick={callInit}
          >
            {snap.initialized ? "已初始化" : "发起初始建仓"}
          </Button>
        </Space>
      )}
    </Card>
  );
}
