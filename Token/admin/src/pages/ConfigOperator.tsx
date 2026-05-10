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
      message.error("请先填入合约地址");
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
        title="合约角色与当前钱包"
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
                title="合约管理员（Owner）"
                valueRender={() => <AddressTag value={snap.owner} full />}
              />
              <Tag color={isOwner ? "green" : "default"} style={{ marginTop: 8 }}>
                {isOwner ? "当前钱包为合约管理员" : "当前钱包非合约管理员"}
              </Tag>
            </Col>
            <Col xs={24} md={8}>
              <Statistic
                title="运营托管账户（Operator）"
                valueRender={() => <AddressTag value={snap.operator} full />}
              />
              <Tag color={isOperator ? "green" : "default"} style={{ marginTop: 8 }}>
                {isOperator ? "当前钱包为运营账户" : "当前钱包非运营账户"}
              </Tag>
            </Col>
            <Col xs={24} md={8}>
              <Statistic title="LP 池中 USCAME 余额" value={formatBnb(snap.pairTokenBalance, 4)} />
              <div style={{ color: "rgba(255,255,255,0.45)", fontSize: 12, marginTop: 4 }}>
                可通过下方「从 LP 池抽取代币」按比例调出
              </div>
            </Col>
          </Row>
        ) : (
          <Alert type="info" message="正在读取链上角色信息…" />
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
      message.error("请输入 1–10000 之间的 bps");
      return;
    }
    modal.confirm({
      title: `从 LP 池中抽取 ${(bps / 100).toFixed(2)}% 的 USCAME`,
      content: `预计抽取 ${preview} USCAME 返回合约，随后由金库与回购流程接管。该操作会冲击价格，请选择合适的比例。`,
      okText: "签名并上链",
      okButtonProps: { danger: true },
      onOk: async () => {
        if (!wallet.account) {
          message.error("请使用运营钱包（Operator）连接");
          return;
        }
        setSubmitting(true);
        try {
          const data = iface.encodeFunctionData("pullPairTokens", [bps]);
          const tx = await sendTokenTransaction(data, wallet.account);
          message.success(`交易已提交：${tx}`);
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
          <SwapOutlined /> 从 LP 池抽取代币（限运营账户）
        </Space>
      }
    >
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        message="执行后会立即拉低代币价格"
        description="该操作按输入的比例（bps）从 LP 池中抽走 USCAME并返回合约本身，随后会触发 PancakeSwap 重新同步价格。请仅在需要调控价格或配合回购计划时使用，并选择谨慎的比例。"
      />
      <Space size="large" align="end">
        <Form layout="vertical" disabled={disabled}>
          <Form.Item label="抽取比例（bps，1 = 0.01%）">
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
        <Statistic title="预计抽取量" value={`${preview} USCAME`} />
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
          仅合约运营账户（Operator）可发起本操作。
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
      message.error("目标地址格式不正确");
      return;
    }
    if (!/^[0-9]+$/.test(valueWei)) {
      message.error("附带 BNB 须为非负整数（单位 wei）");
      return;
    }
    if (!/^0x([a-fA-F0-9]{2})*$/.test(data)) {
      message.error("调用数据必须为 0x 开头且长度为偶数的十六进制");
      return;
    }
    modal.confirm({
      title: "确认以合约身份调用外部合约？",
      content: (
        <div style={{ wordBreak: "break-all", fontFamily: "monospace", fontSize: 12 }}>
          <div>target：{target}</div>
          <div>value：{valueWei} wei</div>
          <div>data：{data.length > 80 ? `${data.slice(0, 80)}…` : data}</div>
        </div>
      ),
      okText: "签名并上链",
      okButtonProps: { danger: true },
      onOk: async () => {
        if (!wallet.account) {
          message.error("请使用运营钱包（Operator）连接");
          return;
        }
        setSubmitting(true);
        try {
          const calldata = iface.encodeFunctionData("operatorCall", [target, BigInt(valueWei), data]);
          const tx = await sendTokenTransaction(calldata, wallet.account);
          message.success(`交易已提交：${tx}`);
        } catch (error) {
          message.error((error as Error).message);
        } finally {
          setSubmitting(false);
        }
      },
    });
  };

  return (
    <Card title={<Space>代合约发起任意调用（限运营账户）</Space>}>
      <Alert
        type="error"
        showIcon
        style={{ marginBottom: 16 }}
        message="高危操作，请仅在必要时使用"
        description="该接口允许运营账户代合约身份对任意地址发起交易，且可动用合约持有的 BNB。仅在合约升级、资金迁移等严格评审后的场景使用。提交前请逐字核对 calldata。"
      />
      <Form layout="vertical" disabled={disabled}>
        <Row gutter={16}>
          <Col xs={24} md={14}>
            <Form.Item label="目标合约地址（target）">
              <Input value={target} onChange={(e) => setTarget(e.target.value.trim())} placeholder="0x..." />
            </Form.Item>
          </Col>
          <Col xs={24} md={10}>
            <Form.Item label="附带 BNB（单位 wei，默认 0）">
              <Input value={valueWei} onChange={(e) => setValueWei(e.target.value.trim())} />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item label="调用数据（calldata，0x 开头）">
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
      message.error("新管理员地址格式不正确");
      return;
    }
    if (next.toLowerCase() === currentOwner.toLowerCase()) {
      message.error("新管理员与现任管理员地址相同");
      return;
    }
    modal.confirm({
      title: "确认转移合约管理员权限？",
      content: (
        <div>
          <div>现任管理员：{currentOwner}</div>
          <div>新管理员：{next}</div>
          <Divider style={{ margin: "8px 0" }} />
          <div style={{ color: "#ff4d4f" }}>
            转移后当前钱包将立即失去全部管理权限，且无法由本面板撤销。
          </div>
        </div>
      ),
      okText: "我已确认，签名转移",
      okButtonProps: { danger: true },
      onOk: async () => {
        if (!wallet.account) {
          message.error("请使用现任管理员钱包连接");
          return;
        }
        setSubmitting(true);
        try {
          const calldata = iface.encodeFunctionData("transferOwnership", [next]);
          const tx = await sendTokenTransaction(calldata, wallet.account);
          message.success(`交易已提交：${tx}`);
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
    <Card title={<Space><UserSwitchOutlined /> 转移合约管理员权限（限现任管理员）</Space>}>
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        message="一旦转移不可撤销"
        description="建议将管理员转移到多签钱包（例如 Gnosis Safe）以提高资金与参数变更的安全性，不建议转移到另一个普通账户。"
      />
      <Form layout="vertical" disabled={disabled}>
        <Form.Item label="新管理员地址">
          <Input value={next} onChange={(e) => setNext(e.target.value.trim())} placeholder="0x..." />
        </Form.Item>
        <Button danger type="primary" loading={submitting} onClick={submit} disabled={disabled}>
          转移管理员权限
        </Button>
      </Form>
    </Card>
  );
}
