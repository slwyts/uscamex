import { useEffect, useState } from "react";
import {
  Card,
  Form,
  InputNumber,
  Input,
  Button,
  Space,
  App,
  Alert,
  Tag,
  Statistic,
  Row,
  Col,
  Divider,
  Typography,
} from "antd";
import { ReloadOutlined, ThunderboltOutlined, SwapOutlined, UserSwitchOutlined } from "@ant-design/icons";
import { Interface } from "ethers";
import { useWallet } from "../hooks/useWallet";
import { ethCall, sendTokenTransaction } from "../utils/chain";
import { isTokenConfigured, loadSettings } from "../utils/settings";
import { formatBnb } from "../utils/bnb";
import AddressTag from "../components/AddressTag";

const ABI = [
  "function owner() view returns (address)",
  "function pair() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function getProtocolConfig() view returns (tuple(address operator,uint16 buyTaxBps,uint16 sellTaxBps,uint128 minDeposit,uint128 maxDeposit,bool buyEnabled,uint16 lpBuildBps,uint16 nodeBps,uint16 builderBuyBps,uint16 vaultBps,uint16 directPoolBps,uint16 directRewardBps,uint16 dailyStaticBps,uint8 settlementPeriodsPerDay,uint32 exitMultipleBps,uint16[10] teamRewardBps,bool deflationEnabled,uint16 deflationHourlyBps,uint16 deflationDailyCapBps,bool buybackEnabled,uint128 buybackPerMinute,uint16 buyTaxBuilderBps,uint16 buyTaxVaultBps,uint16 sellTaxBuilderBps,uint16 sellTaxOwnerBps,uint16 sellTaxVaultBps))",
  "function transferOwnership(address nextOwner)",
  "function pullPairTokens(uint16 bps) returns (uint256 amount)",
  "function operatorCall(address target, uint256 value, bytes data) returns (bytes result)",
];
const iface = new Interface(ABI);

interface Snapshot {
  owner: string;
  operator: string;
  pair: string;
  pairTokenBalance: bigint;
}

export default function ConfigOperator() {
  const { message } = App.useApp();
  const wallet = useWallet();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = async () => {
    const settings = loadSettings();
    if (!isTokenConfigured(settings)) {
      message.error("请先配置合约地址");
      return;
    }
    setLoading(true);
    try {
      const [ownerRet, pairRet, cfgRet] = await Promise.all([
        ethCall(iface.encodeFunctionData("owner", [])),
        ethCall(iface.encodeFunctionData("pair", [])),
        ethCall(iface.encodeFunctionData("getProtocolConfig", [])),
      ]);
      const [owner] = iface.decodeFunctionResult("owner", ownerRet) as unknown as [string];
      const [pair] = iface.decodeFunctionResult("pair", pairRet) as unknown as [string];
      const [cfg] = iface.decodeFunctionResult("getProtocolConfig", cfgRet) as unknown as [
        { operator: string },
      ];
      let pairTokenBalance = 0n;
      if (pair !== "0x0000000000000000000000000000000000000000") {
        const balRet = await ethCall(iface.encodeFunctionData("balanceOf", [pair]));
        const [bal] = iface.decodeFunctionResult("balanceOf", balRet) as unknown as [bigint];
        pairTokenBalance = bal;
      }
      setSnap({
        owner: owner.toLowerCase(),
        operator: cfg.operator.toLowerCase(),
        pair: pair.toLowerCase(),
        pairTokenBalance,
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

  const account = wallet.account?.toLowerCase() ?? "";
  const isOwner = snap !== null && account === snap.owner;
  const isOperator = snap !== null && account === snap.operator;

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card
        title="角色快照"
        extra={
          <Button icon={<ReloadOutlined />} loading={loading} onClick={refresh}>
            刷新
          </Button>
        }
      >
        {snap ? (
          <Row gutter={[16, 16]}>
            <Col xs={24} md={8}>
              <Statistic
                title="Owner"
                valueRender={() => <AddressTag value={snap.owner} full />}
              />
              <Tag color={isOwner ? "green" : "default"} style={{ marginTop: 8 }}>
                {isOwner ? "当前钱包是 Owner" : "当前钱包不是 Owner"}
              </Tag>
            </Col>
            <Col xs={24} md={8}>
              <Statistic
                title="Operator"
                valueRender={() => <AddressTag value={snap.operator} full />}
              />
              <Tag color={isOperator ? "green" : "default"} style={{ marginTop: 8 }}>
                {isOperator ? "当前钱包是 Operator" : "当前钱包不是 Operator"}
              </Tag>
            </Col>
            <Col xs={24} md={8}>
              <Statistic title="Pair 持仓 USCAME" value={formatBnb(snap.pairTokenBalance, 4)} />
              <div style={{ color: "rgba(255,255,255,0.45)", fontSize: 12, marginTop: 4 }}>
                pullPairTokens 按 bps 抽取
              </div>
            </Col>
          </Row>
        ) : (
          <Alert type="info" message="读取链上角色中…" />
        )}
      </Card>

      <PullPairCard disabled={!isOperator} pairBalance={snap?.pairTokenBalance ?? 0n} onDone={refresh} />

      <OperatorCallCard disabled={!isOperator} />

      <TransferOwnershipCard disabled={!isOwner} currentOwner={snap?.owner ?? ""} onDone={refresh} />
    </Space>
  );
}

function PullPairCard({
  disabled,
  pairBalance,
  onDone,
}: {
  disabled: boolean;
  pairBalance: bigint;
  onDone: () => Promise<void>;
}) {
  const { message, modal } = App.useApp();
  const wallet = useWallet();
  const [bps, setBps] = useState<number | null>(50);
  const [submitting, setSubmitting] = useState(false);

  const preview =
    bps && bps > 0 && pairBalance > 0n
      ? formatBnb((pairBalance * BigInt(bps)) / 10_000n, 6)
      : "0";

  const submit = () => {
    if (!bps || bps <= 0 || bps > 10_000) {
      message.error("bps 必须 1-10000");
      return;
    }
    modal.confirm({
      title: `从 Pair 抽取 ${(bps / 100).toFixed(2)}% USCAME`,
      content: `预计抽取 ${preview} USCAME 进合约（随后由 Vault/Buyback 流程处理）。`,
      okText: "签名并广播",
      okButtonProps: { danger: true },
      onOk: async () => {
        if (!wallet.account) {
          message.error("请连接 Operator 钱包");
          return;
        }
        setSubmitting(true);
        try {
          const data = iface.encodeFunctionData("pullPairTokens", [bps]);
          const tx = await sendTokenTransaction(data, wallet.account);
          message.success(`已发送：${tx}`);
          await onDone();
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
      title={
        <Space>
          <SwapOutlined /> pullPairTokens（Operator）
        </Space>
      }
    >
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        message="该操作会立刻拉低池子价格"
        description="按 bps 把 Pair 持有的 USCAME 转回合约自身并触发 sync()。请谨慎选择比例并配合回购窗口使用。"
      />
      <Space size="large" align="end">
        <Form layout="vertical" disabled={disabled}>
          <Form.Item label="bps（1 = 0.01%）">
            <InputNumber
              min={1}
              max={10_000}
              step={10}
              value={bps}
              onChange={(value) => setBps(typeof value === "number" ? value : null)}
              style={{ width: 180 }}
            />
          </Form.Item>
        </Form>
        <Statistic title="预计抽取" value={`${preview} USCAME`} />
        <Button
          type="primary"
          danger
          icon={<ThunderboltOutlined />}
          disabled={disabled}
          loading={submitting}
          onClick={submit}
        >
          发起抽取
        </Button>
      </Space>
      {disabled && (
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          仅当前 Operator 钱包可调用。
        </Typography.Paragraph>
      )}
    </Card>
  );
}

function OperatorCallCard({ disabled }: { disabled: boolean }) {
  const { message, modal } = App.useApp();
  const wallet = useWallet();
  const [target, setTarget] = useState("");
  const [valueWei, setValueWei] = useState("0");
  const [data, setData] = useState("0x");
  const [submitting, setSubmitting] = useState(false);

  const submit = () => {
    if (!/^0x[a-fA-F0-9]{40}$/.test(target)) {
      message.error("target 不是合法地址");
      return;
    }
    if (!/^[0-9]+$/.test(valueWei)) {
      message.error("value 必须是非负整数（wei）");
      return;
    }
    if (!/^0x([a-fA-F0-9]{2})*$/.test(data)) {
      message.error("data 必须是 0x 开头的偶数长度十六进制");
      return;
    }
    modal.confirm({
      title: "确认发起 operatorCall？",
      content: (
        <div style={{ wordBreak: "break-all", fontFamily: "monospace", fontSize: 12 }}>
          <div>target: {target}</div>
          <div>value: {valueWei} wei</div>
          <div>data: {data.length > 80 ? `${data.slice(0, 80)}…` : data}</div>
        </div>
      ),
      okText: "签名并广播",
      okButtonProps: { danger: true },
      onOk: async () => {
        if (!wallet.account) {
          message.error("请连接 Operator 钱包");
          return;
        }
        setSubmitting(true);
        try {
          const calldata = iface.encodeFunctionData("operatorCall", [target, BigInt(valueWei), data]);
          const tx = await sendTokenTransaction(calldata, wallet.account);
          message.success(`已发送：${tx}`);
        } catch (error) {
          message.error((error as Error).message);
        } finally {
          setSubmitting(false);
        }
      },
    });
  };

  return (
    <Card title={<Space>operatorCall（Operator 通用调用）</Space>}>
      <Alert
        type="error"
        showIcon
        style={{ marginBottom: 16 }}
        message="高危操作"
        description="该接口允许 Operator 用合约身份对任意地址发起调用，且会消耗合约持有的 BNB。仅在升级或迁移流程中使用，每次调用前请离线核对 calldata。"
      />
      <Form layout="vertical" disabled={disabled}>
        <Row gutter={16}>
          <Col xs={24} md={14}>
            <Form.Item label="target">
              <Input value={target} onChange={(e) => setTarget(e.target.value.trim())} placeholder="0x..." />
            </Form.Item>
          </Col>
          <Col xs={24} md={10}>
            <Form.Item label="value (wei)">
              <Input value={valueWei} onChange={(e) => setValueWei(e.target.value.trim())} />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item label="data (calldata, 0x...)">
          <Input.TextArea
            value={data}
            onChange={(e) => setData(e.target.value.trim())}
            autoSize={{ minRows: 3, maxRows: 8 }}
            style={{ fontFamily: "monospace" }}
          />
        </Form.Item>
        <Button danger type="primary" loading={submitting} onClick={submit} disabled={disabled}>
          发起调用
        </Button>
      </Form>
    </Card>
  );
}

function TransferOwnershipCard({
  disabled,
  currentOwner,
  onDone,
}: {
  disabled: boolean;
  currentOwner: string;
  onDone: () => Promise<void>;
}) {
  const { message, modal } = App.useApp();
  const wallet = useWallet();
  const [next, setNext] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = () => {
    if (!/^0x[a-fA-F0-9]{40}$/.test(next)) {
      message.error("nextOwner 不是合法地址");
      return;
    }
    if (next.toLowerCase() === currentOwner.toLowerCase()) {
      message.error("新 Owner 与当前 Owner 相同");
      return;
    }
    modal.confirm({
      title: "确认转移 Owner？",
      content: (
        <div>
          <div>原 Owner：{currentOwner}</div>
          <div>新 Owner：{next}</div>
          <Divider style={{ margin: "8px 0" }} />
          <div style={{ color: "#ff4d4f" }}>
            转移后当前钱包将立即失去管理权限，无法回滚。
          </div>
        </div>
      ),
      okText: "我已确认，签名转移",
      okButtonProps: { danger: true },
      onOk: async () => {
        if (!wallet.account) {
          message.error("请连接 Owner 钱包");
          return;
        }
        setSubmitting(true);
        try {
          const calldata = iface.encodeFunctionData("transferOwnership", [next]);
          const tx = await sendTokenTransaction(calldata, wallet.account);
          message.success(`已发送：${tx}`);
          await onDone();
        } catch (error) {
          message.error((error as Error).message);
        } finally {
          setSubmitting(false);
        }
      },
    });
  };

  return (
    <Card title={<Space><UserSwitchOutlined /> transferOwnership（Owner）</Space>}>
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        message="不可逆操作"
        description="建议优先转移到多签合约（如 Gnosis Safe）地址，而非另一个 EOA。"
      />
      <Form layout="vertical" disabled={disabled}>
        <Form.Item label="新 Owner 地址">
          <Input value={next} onChange={(e) => setNext(e.target.value.trim())} placeholder="0x..." />
        </Form.Item>
        <Button danger type="primary" loading={submitting} onClick={submit} disabled={disabled}>
          转移 Owner
        </Button>
      </Form>
    </Card>
  );
}
