import { useEffect, useState } from "react";
import { Card, Descriptions, Button, Space, App, Alert, Tag, Statistic, Row, Col } from "antd";
import { ReloadOutlined, RocketOutlined } from "@ant-design/icons";
import { Interface } from "ethers";
import { useWallet } from "../hooks/useWallet";
import { ethCall, ethCallTo, getReadProvider, sendTokenTransaction } from "../utils/chain";
import { isTokenConfigured, loadSettings } from "../utils/settings";
import { formatBnb } from "../utils/bnb";
import AddressTag from "../components/AddressTag";

const ZERO = "0x0000000000000000000000000000000000000000";

const ABI = [
  "function initializeLP()",
  "function initialized() view returns (bool)",
  "function pair() view returns (address)",
  "function vault() view returns (address)",
  "function owner() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
];
const iface = new Interface(ABI);
const pairIface = new Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
]);

interface LpPoolSnapshot {
  token0: string;
  token1: string;
  uscamexReserve: bigint;
  bnbReserve: bigint;
}

interface Snapshot {
  initialized: boolean;
  pair: string;
  vault: string;
  owner: string;
  contractTokenBalance: bigint;
  contractBnbBalance: bigint;
  lpPool: LpPoolSnapshot | null;
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
      const pairAddress = pair.toLowerCase();
      setSnap({
        initialized,
        pair: pairAddress,
        vault: vault.toLowerCase(),
        owner: owner.toLowerCase(),
        contractTokenBalance: tokenBal,
        contractBnbBalance: bnb,
        lpPool: await readLpPool(pairAddress, settings.tokenAddress),
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
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
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
                {snap.pair === ZERO ? (
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

      <Card title="LP 池持仓">
        {snap?.lpPool ? (
          <Space direction="vertical" size="large" style={{ width: "100%" }}>
            <Row gutter={[16, 16]}>
              <Col xs={24} md={6}>
                <Statistic title="池内 BNB" value={formatBnb(snap.lpPool.bnbReserve, 6)} />
              </Col>
              <Col xs={24} md={6}>
                <Statistic title="池内 USCAME" value={formatBnb(snap.lpPool.uscamexReserve, 4)} />
              </Col>
              <Col xs={24} md={6}>
                <Statistic
                  title="价格（BNB / USCAME）"
                  value={formatRatio(snap.lpPool.bnbReserve, snap.lpPool.uscamexReserve, 12)}
                />
              </Col>
              <Col xs={24} md={6}>
                <Statistic
                  title="价格（USCAME / BNB）"
                  value={formatRatio(snap.lpPool.uscamexReserve, snap.lpPool.bnbReserve, 4)}
                />
              </Col>
            </Row>
            <Descriptions bordered column={1} size="small">
              <Descriptions.Item label="token0">
                <AddressTag value={snap.lpPool.token0} full />
              </Descriptions.Item>
              <Descriptions.Item label="token1">
                <AddressTag value={snap.lpPool.token1} full />
              </Descriptions.Item>
            </Descriptions>
          </Space>
        ) : (
          <Alert type="info" showIcon message="尚未读取到 LP 池储备" />
        )}
      </Card>
    </Space>
  );
}

async function readLpPool(pair: string, tokenAddress: string): Promise<LpPoolSnapshot | null> {
  if (!pair || pair === ZERO) return null;
  const [token0Ret, token1Ret, reservesRet] = await Promise.all([
    ethCallTo(pair, pairIface.encodeFunctionData("token0", [])),
    ethCallTo(pair, pairIface.encodeFunctionData("token1", [])),
    ethCallTo(pair, pairIface.encodeFunctionData("getReserves", [])),
  ]);
  const [token0] = pairIface.decodeFunctionResult("token0", token0Ret) as unknown as [string];
  const [token1] = pairIface.decodeFunctionResult("token1", token1Ret) as unknown as [string];
  const [reserve0, reserve1] = pairIface.decodeFunctionResult("getReserves", reservesRet) as unknown as [bigint, bigint, bigint];
  const normalizedToken = tokenAddress.toLowerCase();
  const normalizedToken0 = token0.toLowerCase();
  const normalizedToken1 = token1.toLowerCase();
  if (normalizedToken0 !== normalizedToken && normalizedToken1 !== normalizedToken) {
    return null;
  }
  const uscamexReserve = normalizedToken0 === normalizedToken ? reserve0 : reserve1;
  const bnbReserve = normalizedToken0 === normalizedToken ? reserve1 : reserve0;
  return {
    token0: normalizedToken0,
    token1: normalizedToken1,
    uscamexReserve,
    bnbReserve,
  };
}

function formatRatio(numerator: bigint, denominator: bigint, decimals: number): string {
  if (denominator === 0n) return "0";
  const scale = 10n ** BigInt(decimals);
  const scaled = (numerator * scale) / denominator;
  if (scaled === 0n && numerator !== 0n) {
    return `<0.${"0".repeat(Math.max(decimals - 1, 0))}1`;
  }
  const whole = scaled / scale;
  const fraction = (scaled % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
