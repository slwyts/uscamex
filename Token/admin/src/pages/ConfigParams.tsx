import { useEffect, useState } from "react";
import {
  Card,
  Form,
  InputNumber,
  Input,
  Switch,
  Button,
  Space,
  Row,
  Col,
  Divider,
  Tag,
  App,
  Tooltip,
  Spin,
  Alert,
} from "antd";
import { ReloadOutlined, SaveOutlined } from "@ant-design/icons";
import { Interface } from "ethers";
import { useWallet } from "../hooks/useWallet";
import { ethCall, sendTokenTransaction } from "../utils/chain";
import { loadSettings, isTokenConfigured } from "../utils/settings";
import { formatBnb, parseBnb } from "../utils/bnb";

const ABI = [
  "function getProtocolConfig() view returns (tuple(address operator,uint16 buyTaxBps,uint16 sellTaxBps,uint128 minDeposit,uint128 maxDeposit,bool buyEnabled,uint16 lpBuildBps,uint16 nodeBps,uint16 builderBuyBps,uint16 vaultBps,uint16 directPoolBps,uint16 directRewardBps,uint16 dailyStaticBps,uint8 settlementPeriodsPerDay,uint32 exitMultipleBps,uint16[10] teamRewardBps,bool deflationEnabled,uint16 deflationHourlyBps,uint16 deflationDailyCapBps,bool buybackEnabled,uint128 buybackPerMinute,uint16 buyTaxBuilderBps,uint16 buyTaxVaultBps,uint16 sellTaxBuilderBps,uint16 sellTaxOwnerBps,uint16 sellTaxVaultBps))",
  "function setProtocolConfig(tuple(address operator,uint16 buyTaxBps,uint16 sellTaxBps,uint128 minDeposit,uint128 maxDeposit,bool buyEnabled,uint16 lpBuildBps,uint16 nodeBps,uint16 builderBuyBps,uint16 vaultBps,uint16 directPoolBps,uint16 directRewardBps,uint16 dailyStaticBps,uint8 settlementPeriodsPerDay,uint32 exitMultipleBps,uint16[10] teamRewardBps,bool deflationEnabled,uint16 deflationHourlyBps,uint16 deflationDailyCapBps,bool buybackEnabled,uint128 buybackPerMinute,uint16 buyTaxBuilderBps,uint16 buyTaxVaultBps,uint16 sellTaxBuilderBps,uint16 sellTaxOwnerBps,uint16 sellTaxVaultBps) next)",
];
const iface = new Interface(ABI);

interface FormShape {
  operator: string;
  buyTaxBps: number;
  sellTaxBps: number;
  minDepositBnb: string;
  maxDepositBnb: string;
  buyEnabled: boolean;
  lpBuildBps: number;
  nodeBps: number;
  builderBuyBps: number;
  vaultBps: number;
  directPoolBps: number;
  directRewardBps: number;
  dailyStaticBps: number;
  settlementPeriodsPerDay: number;
  exitMultipleBps: number;
  teamRewardBps: number[];
  deflationEnabled: boolean;
  deflationHourlyBps: number;
  deflationDailyCapBps: number;
  buybackEnabled: boolean;
  buybackPerMinuteBnb: string;
  buyTaxBuilderBps: number;
  buyTaxVaultBps: number;
  sellTaxBuilderBps: number;
  sellTaxOwnerBps: number;
  sellTaxVaultBps: number;
}

export default function ConfigParams() {
  const { message, modal } = App.useApp();
  const wallet = useWallet();
  const [form] = Form.useForm<FormShape>();
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const settings = loadSettings();

  const fetchConfig = async () => {
    if (!isTokenConfigured(settings)) {
      message.error("请先在右上角「连接设置」中填入合约地址");
      return;
    }
    setLoading(true);
    try {
      const data = iface.encodeFunctionData("getProtocolConfig", []);
      const ret = await ethCall(data);
      const [decoded] = iface.decodeFunctionResult("getProtocolConfig", ret);
      const c = decoded as Record<string, unknown> & { teamRewardBps: bigint[] };
      const value: FormShape = {
        operator: c.operator as string,
        buyTaxBps: Number(c.buyTaxBps),
        sellTaxBps: Number(c.sellTaxBps),
        minDepositBnb: formatBnb(c.minDeposit as bigint, 18),
        maxDepositBnb: formatBnb(c.maxDeposit as bigint, 18),
        buyEnabled: Boolean(c.buyEnabled),
        lpBuildBps: Number(c.lpBuildBps),
        nodeBps: Number(c.nodeBps),
        builderBuyBps: Number(c.builderBuyBps),
        vaultBps: Number(c.vaultBps),
        directPoolBps: Number(c.directPoolBps),
        directRewardBps: Number(c.directRewardBps),
        dailyStaticBps: Number(c.dailyStaticBps),
        settlementPeriodsPerDay: Number(c.settlementPeriodsPerDay),
        exitMultipleBps: Number(c.exitMultipleBps),
        teamRewardBps: (c.teamRewardBps as bigint[]).map((value) => Number(value)),
        deflationEnabled: Boolean(c.deflationEnabled),
        deflationHourlyBps: Number(c.deflationHourlyBps),
        deflationDailyCapBps: Number(c.deflationDailyCapBps),
        buybackEnabled: Boolean(c.buybackEnabled),
        buybackPerMinuteBnb: formatBnb(c.buybackPerMinute as bigint, 18),
        buyTaxBuilderBps: Number(c.buyTaxBuilderBps),
        buyTaxVaultBps: Number(c.buyTaxVaultBps),
        sellTaxBuilderBps: Number(c.sellTaxBuilderBps),
        sellTaxOwnerBps: Number(c.sellTaxOwnerBps),
        sellTaxVaultBps: Number(c.sellTaxVaultBps),
      };
      form.setFieldsValue(value);
      setLoaded(true);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchConfig().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (values: FormShape) => {
    if (!wallet.account) {
      message.error("请先连接合约管理员钱包");
      return;
    }
    let payload: unknown;
    try {
      payload = {
        operator: values.operator,
        buyTaxBps: values.buyTaxBps,
        sellTaxBps: values.sellTaxBps,
        minDeposit: parseBnb(values.minDepositBnb),
        maxDeposit: parseBnb(values.maxDepositBnb),
        buyEnabled: values.buyEnabled,
        lpBuildBps: values.lpBuildBps,
        nodeBps: values.nodeBps,
        builderBuyBps: values.builderBuyBps,
        vaultBps: values.vaultBps,
        directPoolBps: values.directPoolBps,
        directRewardBps: values.directRewardBps,
        dailyStaticBps: values.dailyStaticBps,
        settlementPeriodsPerDay: values.settlementPeriodsPerDay,
        exitMultipleBps: values.exitMultipleBps,
        teamRewardBps: values.teamRewardBps,
        deflationEnabled: values.deflationEnabled,
        deflationHourlyBps: values.deflationHourlyBps,
        deflationDailyCapBps: values.deflationDailyCapBps,
        buybackEnabled: values.buybackEnabled,
        buybackPerMinute: parseBnb(values.buybackPerMinuteBnb),
        buyTaxBuilderBps: values.buyTaxBuilderBps,
        buyTaxVaultBps: values.buyTaxVaultBps,
        sellTaxBuilderBps: values.sellTaxBuilderBps,
        sellTaxOwnerBps: values.sellTaxOwnerBps,
        sellTaxVaultBps: values.sellTaxVaultBps,
      };
    } catch (error) {
      message.error((error as Error).message);
      return;
    }
    modal.confirm({
      title: "确认提交新的协议参数？",
      content: "该交易会将所有参数写入链上合约，会立即生效。建议先仔细核对每项数值后再提交。",
      okText: "签名并上链",
      onOk: async () => {
        setSubmitting(true);
        try {
          const data = iface.encodeFunctionData("setProtocolConfig", [payload]);
          const tx = await sendTokenTransaction(data, wallet.account);
          message.success(`交易已提交：${tx}`);
          await fetchConfig();
        } catch (error) {
          message.error((error as Error).message);
        } finally {
          setSubmitting(false);
        }
      },
    });
  };

  if (loading && !loaded) {
    return (
      <Card>
        <Spin />
      </Card>
    );
  }

  return (
    <Card
      title="协议参数（链上）"
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} onClick={fetchConfig} loading={loading}>
            重新读取链上参数
          </Button>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="物财业务参数按「基点 (bps)」填写：1% = 100 bps，例如10% = 1000；BNB 金额可填入小数。修改后需点击「提交上链」并由管理员钱包签名才会生效。"
      />
      <Form<FormShape>
        form={form}
        layout="vertical"
        onFinish={submit}
        initialValues={{
          teamRewardBps: Array.from({ length: 10 }, () => 0),
        }}
      >
        <Divider orientation="left">运营账户与总开关</Divider>
        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item
              label="运营托管账户（operator，可调用高级接口）"
              name="operator"
              rules={[{ required: true, pattern: /^0x[0-9a-fA-F]{40}$/, message: "地址格式不正确" }]}
            >
              <Input placeholder="0x..." />
            </Form.Item>
          </Col>
          <Col xs={12} md={6}>
            <Form.Item label="允许购买代币" name="buyEnabled" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Col>
          <Col xs={12} md={6}>
            <Form.Item label="启用按小时通缩" name="deflationEnabled" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Col>
        </Row>

        <Divider orientation="left">入金金额范围</Divider>
        <Row gutter={16}>
          <Col xs={12}>
            <Form.Item label="最低入金金额（BNB）" name="minDepositBnb" rules={[{ required: true }]}>
              <Input placeholder="例：0.1" />
            </Form.Item>
          </Col>
          <Col xs={12}>
            <Form.Item label="最高入金金额（BNB）" name="maxDepositBnb" rules={[{ required: true }]}>
              <Input placeholder="例：5" />
            </Form.Item>
          </Col>
        </Row>

        <Divider orientation="left">买卖总税率（bps）</Divider>
        <Row gutter={16}>
          <Col xs={12} md={6}><BpsField label="买入总税率" name="buyTaxBps" /></Col>
          <Col xs={12} md={6}><BpsField label="卖出总税率" name="sellTaxBps" /></Col>
        </Row>

        <Divider orientation="left">买入税收分配（bps）</Divider>
        <Row gutter={16}>
          <Col xs={12} md={6}><BpsField label="划入 Builder 购买池" name="buyTaxBuilderBps" /></Col>
          <Col xs={12} md={6}><BpsField label="划入金库" name="buyTaxVaultBps" /></Col>
        </Row>

        <Divider orientation="left">卖出税收分配（bps）</Divider>
        <Row gutter={16}>
          <Col xs={12} md={6}><BpsField label="划入 Builder" name="sellTaxBuilderBps" /></Col>
          <Col xs={12} md={6}><BpsField label="划入管理员" name="sellTaxOwnerBps" /></Col>
          <Col xs={12} md={6}><BpsField label="划入金库" name="sellTaxVaultBps" /></Col>
        </Row>

        <Divider orientation="left">入金资金分配（bps）</Divider>
        <Row gutter={16}>
          <Col xs={12} md={6}><BpsField label="LP 建仓" name="lpBuildBps" /></Col>
          <Col xs={12} md={6}><BpsField label="节点奖励池" name="nodeBps" /></Col>
          <Col xs={12} md={6}><BpsField label="Builder 购买" name="builderBuyBps" /></Col>
          <Col xs={12} md={6}><BpsField label="金库" name="vaultBps" /></Col>
          <Col xs={12} md={6}><BpsField label="直推奖池" name="directPoolBps" /></Col>
          <Col xs={12} md={6}><BpsField label="直推即时奖" name="directRewardBps" /></Col>
        </Row>

        <Divider orientation="left">静态产出与退场</Divider>
        <Row gutter={16}>
          <Col xs={12} md={6}><BpsField label="每日静态产出（bps）" name="dailyStaticBps" /></Col>
          <Col xs={12} md={6}>
            <Form.Item
              label={<Tooltip title="一天内进行几次静态结算，例如24 表示每小时一次">每日结算次数</Tooltip>}
              name="settlementPeriodsPerDay"
              rules={[{ required: true }]}
            >
              <InputNumber min={1} max={255} style={{ width: "100%" }} />
            </Form.Item>
          </Col>
          <Col xs={12} md={6}>
            <Form.Item
              label={<Tooltip title="退场以本金为基础乘以一个倍数。以 bps 表示，例如30000 = 3 倍本金。">退场倍数（bps）</Tooltip>}
              name="exitMultipleBps"
              rules={[{ required: true }]}
            >
              <InputNumber min={0} style={{ width: "100%" }} />
            </Form.Item>
          </Col>
        </Row>

        <Divider orientation="left">团队 10 代动态奖励（bps）</Divider>
        <Row gutter={16}>
          {Array.from({ length: 10 }).map((_, index) => (
            <Col xs={12} md={6} lg={4} key={index}>
              <Form.Item
                label={`第 ${index + 1} 代`}
                name={["teamRewardBps", index]}
                rules={[{ required: true }]}
              >
                <InputNumber min={0} max={10000} style={{ width: "100%" }} />
              </Form.Item>
            </Col>
          ))}
        </Row>

        <Divider orientation="left">通缩与回购</Divider>
        <Row gutter={16}>
          <Col xs={12} md={6}><BpsField label="每小时通缩比例（bps）" name="deflationHourlyBps" /></Col>
          <Col xs={12} md={6}><BpsField label="每日通缩上限（bps）" name="deflationDailyCapBps" /></Col>
          <Col xs={12} md={6}>
            <Form.Item label="启用自动回购" name="buybackEnabled" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Col>
          <Col xs={12} md={6}>
            <Form.Item label="每分钟回购金额（BNB）" name="buybackPerMinuteBnb" rules={[{ required: true }]}>
              <Input placeholder="例：0.1" />
            </Form.Item>
          </Col>
        </Row>

        <Divider />
        <Space>
          <Button
            type="primary"
            htmlType="submit"
            icon={<SaveOutlined />}
            loading={submitting}
          >
            提交到链上
          </Button>
          <Tag color={wallet.account ? "green" : "default"}>
            {wallet.account ? `签名钱包：${wallet.account.slice(0, 10)}…` : "尚未连接钱包"}
          </Tag>
        </Space>
      </Form>
    </Card>
  );
}

function BpsField({ label, name }: { label: string; name: string }) {
  return (
    <Form.Item label={label} name={name} rules={[{ required: true }]}>
      <InputNumber min={0} max={10000} style={{ width: "100%" }} />
    </Form.Item>
  );
}
