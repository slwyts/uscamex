import { Card, Col, Row, Statistic, Tag, Spin, Empty, Space, Button, App } from "antd";
import {
  ClusterOutlined,
  CrownOutlined,
  FireOutlined,
  GlobalOutlined,
  ReloadOutlined,
  SafetyOutlined,
  SettingOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { api, apiErrorMessage, type GlobalStats, type PublicHealth } from "../utils/api";
import OwnerGate from "../components/OwnerGate";
import AddressTag from "../components/AddressTag";
import { formatBnb } from "../utils/bnb";
import { bpsToPercentText } from "../utils/bps";

export default function QueryOverview() {
  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <PublicHealthCard />
      <OwnerGate>
        <StatsCard />
      </OwnerGate>
    </Space>
  );
}

function PublicHealthCard() {
  const { data, isFetching, refetch, error } = useQuery({
    queryKey: ["public-health"],
    queryFn: async () => (await api().get<PublicHealth>("/api/health")).data,
    refetchInterval: 30_000,
  });
  return (
    <Card
      className="section-card"
      title={
        <Space>
          <GlobalOutlined /> 节点运行状态
        </Space>
      }
      extra={
        <Button
          icon={<ReloadOutlined />}
          loading={isFetching}
          onClick={() => refetch()}
          size="small"
        >
          刷新
        </Button>
      }
    >
      {error && <Empty description={apiErrorMessage(error)} />}
      {data && (
        <Row gutter={[16, 16]}>
          <Col xs={12} md={6}>
            <Statistic title="链 ID" value={data.chain_id} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="最新区块" value={data.chain_head ?? "-"} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="索引起始区块" value={data.indexer_start_block} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="区块确认数" value={data.confirmations} />
          </Col>
          <Col xs={24} md={12}>
            <span style={{ color: "rgba(255,255,255,0.55)" }}>代币合约：</span>
            <AddressTag value={data.token_address} full />
          </Col>
          <Col xs={24} md={12}>
            <span style={{ color: "rgba(255,255,255,0.55)" }}>PancakeSwap 路由：</span>
            <AddressTag value={data.pancake_v2_router} full />
          </Col>
        </Row>
      )}
    </Card>
  );
}

function StatsCard() {
  const { message } = App.useApp();
  const { data, isFetching, refetch, error } = useQuery({
    queryKey: ["admin-stats"],
    queryFn: async () => (await api().get<GlobalStats>("/api/admin/stats")).data,
    refetchInterval: 20_000,
  });
  if (error) {
    return (
      <Card>
        <Empty description={apiErrorMessage(error)}>
          <Button onClick={() => { refetch().catch((e) => message.error(apiErrorMessage(e))); }}>
            重试
          </Button>
        </Empty>
      </Card>
    );
  }
  if (!data) {
    return (
      <Card>
        <Spin />
      </Card>
    );
  }
  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card
        className="section-card"
        title={
          <Space>
            <CrownOutlined /> 核心运营指标
          </Space>
        }
        extra={
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={isFetching}
            onClick={() => refetch()}
          >
            刷新
          </Button>
        }
      >
        <Row gutter={[16, 16]}>
          <Metric title="用户总数" value={data.total_users} />
          <Metric title="已绑定推荐关系" value={data.bound_users} />
          <Metric title="运行中账户" value={data.active_users} />
          <Metric title="已退场账户" value={data.exited_users} valueStyle={{ color: "#ff7875" }} />
          <Metric title="节点数量" value={data.nodes_count} />
          <Metric title="协议参数" value={data.protocol_config_initialized ? "已初始化" : "尚未初始化"}
                  valueStyle={{ color: data.protocol_config_initialized ? "#73d13d" : "#ff7875" }} />
          <Metric title="当前业务日序号" value={data.current_day} />
          <Metric
            title="今日通缩已用比例"
            value={`${bpsToPercentText(data.deflation_used_bps)}%`}
          />
        </Row>
      </Card>
      <Card
        className="section-card"
        title={
          <Space>
            <ThunderboltOutlined /> 资金位
          </Space>
        }
      >
        <Row gutter={[16, 16]}>
          <Metric title="用户累计入金 (BNB)" value={formatBnb(data.total_principal_bnb, 4)} />
          <Metric title="累计静态产出 (BNB)" value={formatBnb(data.total_static_paid_bnb, 4)} />
          <Metric title="累计动态产出 (BNB)" value={formatBnb(data.total_dynamic_paid_bnb, 4)} />
          <Metric title="金库余额 (BNB)" value={formatBnb(data.vault_bnb, 4)} />
          <Metric title="Owner 地址 BNB" value={formatBnb(data.owner_bnb, 4)} />
          <Metric title="Builder 持仓价值 (BNB)" value={formatBnb(data.builder_token_value_bnb, 4)} />
          <Metric title="Builder 持仓数量" value={formatBnb(data.builder_token_amount, 4)} />
          <Metric title="累计销毁代币" value={formatBnb(data.burned_tokens, 4)} />
          <Metric title="税收销毁价值 (BNB)" value={formatBnb(data.tax_burned_token_value_bnb, 4)} />
          <Metric title="LP 代币储备" value={formatBnb(data.pair_token_reserve, 4)} />
          <Metric title="LP BNB 储备" value={formatBnb(data.pair_bnb_reserve, 4)} />
        </Row>
      </Card>
      <Card
        className="section-card"
        title={
          <Space>
            <ClusterOutlined /> 索引与执行状态
          </Space>
        }
      >
        <Row gutter={[16, 16]}>
          <Metric title="最新区块" value={data.chain_head ?? "-"} />
          <Metric title="已索引区块" value={data.last_indexed_block ?? "-"} />
          <Metric title="已处理事件数" value={data.processed_events} />
          <Metric title="已结算质押" value={data.processed_settlements} />
          <Metric title="待执行交易" value={data.pending_commands} />
          <Metric title="已提交交易" value={data.submitted_commands} />
          <Metric title="已确认交易" value={data.confirmed_commands} valueStyle={{ color: "#73d13d" }} />
          <Metric title="失败交易" value={data.failed_commands} valueStyle={{ color: "#ff7875" }} />
        </Row>
        <div style={{ marginTop: 16 }}>
          <Space wrap>
            <Tag icon={<SafetyOutlined />} color="purple">
              推荐根：<AddressTag value={data.root} />
            </Tag>
            <Tag icon={<FireOutlined />} color="orange">
              今日通缩已用 {bpsToPercentText(data.deflation_used_bps)}%
            </Tag>
            <Tag icon={<SettingOutlined />} color={data.protocol_config_initialized ? "green" : "red"}>
              协议参数 {data.protocol_config_initialized ? "已初始化" : "尚未初始化"}
            </Tag>
          </Space>
        </div>
      </Card>
    </Space>
  );
}

function Metric({
  title,
  value,
  valueStyle,
}: {
  title: string;
  value: string | number;
  valueStyle?: React.CSSProperties;
}) {
  return (
    <Col xs={12} sm={8} md={6} xl={4}>
      <Card className="metric-card" size="small" bordered={false} style={{ background: "#171a23" }}>
        <Statistic title={title} value={value} valueStyle={valueStyle} />
      </Card>
    </Col>
  );
}
