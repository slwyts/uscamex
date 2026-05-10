import { Card, Col, Row, Statistic, Tag, Spin, Empty, Space, Button, App, Tooltip } from "antd";
import { InfoCircleOutlined } from "@ant-design/icons";
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
            <Statistic
              title={
                <HelpLabel
                  text="链 ID"
                  tip="当前节点连接的区块链网络编号。56 = BSC 主网；97 = BSC 测试网。请确认与钱包侧的网络一致。"
                />
              }
              value={data.chain_id}
            />
          </Col>
          <Col xs={12} md={6}>
            <Statistic
              title={
                <HelpLabel
                  text="最新区块"
                  tip="RPC 当前返回的链上最新区块高度，反映节点与全网的同步进度。"
                />
              }
              value={data.chain_head ?? "-"}
            />
          </Col>
          <Col xs={12} md={6}>
            <Statistic
              title={
                <HelpLabel
                  text="索引起始区块"
                  tip="后台从该区块开始扫描事件。通常是合约部署的区块；调小会重新拉取历史，调大会跳过更早的事件。"
                />
              }
              value={data.indexer_start_block}
            />
          </Col>
          <Col xs={12} md={6}>
            <Statistic
              title={
                <HelpLabel
                  text="区块确认数"
                  tip="后台等待多少个区块确认后才认为事件最终生效，用于抵御短暂回滚。BSC 一般 3~12。"
                />
              }
              value={data.confirmations}
            />
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
          <Metric
            title="用户总数"
            value={data.total_users}
            tip="已被后台记录过的全部地址数量，包含尚未入金但已绑定推荐关系的地址。"
          />
          <Metric
            title="已绑定推荐关系"
            value={data.bound_users}
            tip="在链上设置了上级推荐人（不包含推荐根节点）的地址数量。该数字与“用户总数”差额代表尚未绑定上级的地址。"
          />
          <Metric
            title="运行中账户"
            value={data.active_users}
            tip="已完成入金、仓位仍在产出静态/动态收益的账户数。退场或主动撤出 LP 后不计在内。"
          />
          <Metric
            title="已退场账户"
            value={data.exited_users}
            valueStyle={{ color: "#ff7875" }}
            tip="累计收益达到本金 N 倍后被自动退场，或主动撤出 LP 后不再产出收益的账户数。重新入金后会重新计入“运行中账户”。"
          />
          <Metric
            title="节点数量"
            value={data.nodes_count}
            tip="在「节点配置」中登记且权重 > 0 的地址数量。节点参与入金中 10% 节点分红的按权重平均分配。"
          />
          <Metric
            title="协议参数状态"
            value={data.protocol_config_initialized ? "已初始化" : "尚未初始化"}
            valueStyle={{ color: data.protocol_config_initialized ? "#73d13d" : "#ff7875" }}
            tip="是否已通过「协议参数」页面向合约提交过完整参数。未初始化时，链下运营会使用默认值，不会参与业务计算。"
          />
          <Metric
            title="当前业务日序号"
            value={data.current_day}
            tip="以合约的「业务日」为单位计数（1 个业务日 = 24 小时）。序号用于静态产出、团队奖励、通缩上限等按日周期结算的业务。"
          />
          <Metric
            title="今日通缩已使用比例"
            value={`${bpsToPercentText(data.deflation_used_bps)}%`}
            tip="今日已从 LP 池抽走的代币占「每日上限」的比例。达到 100% 后当日不再自动抽取，过零点后重置。"
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
          <Metric
            title="用户累计入金 (BNB)"
            value={formatBnb(data.total_principal_bnb, 4)}
            tip="全体用户向合约转入 BNB 作为 LP 本金的累计总额，不含退场后退还部分。"
          />
          <Metric
            title="累计静态产出 (BNB)"
            value={formatBnb(data.total_static_paid_bnb, 4)}
            tip="按每日静态收益率（默认 0.8%）发放给用户的代币折算为 BNB 后的累计金额。反映项目的总付付压力。"
          />
          <Metric
            title="累计动态产出 (BNB)"
            value={formatBnb(data.total_dynamic_paid_bnb, 4)}
            tip="直推奖与 10 代团队奖累计发放金额（BNB 计价）。与静态产出一起计入「退场倍数」。"
          />
          <Metric
            title="回购金库余额 (BNB)"
            value={formatBnb(data.vault_bnb, 4)}
            tip="BuybackVault 子合约余额。资金来自买入税、卖出税以及入金分配，按设置每分钟从市场买回代币并送黑洞。"
          />
          <Metric
            title="管理员地址 BNB"
            value={formatBnb(data.owner_bnb, 4)}
            tip="合约 owner() 账户在链上的 BNB 余额。卖出税中划入「生态建设基金」的 BNB 会直接进入该账户。"
          />
          <Metric
            title="LP 建设者分红池价值 (BNB)"
            value={formatBnb(data.builder_token_value_bnb, 4)}
            tip="合约自身地址所持 USCAME 按当前 LP 价格折算出的 BNB 价值。这些代币来自买入税、卖出税与每小时通缩抽取。"
          />
          <Metric
            title="LP 建设者分红池代币数量"
            value={formatBnb(data.builder_token_amount, 4)}
            tip="合约自身地址所持 USCAME 代币数量（未折算价格）。可在「资产提取」中划转。"
          />
          <Metric
            title="累计销毁代币数量"
            value={formatBnb(data.burned_tokens, 4)}
            tip="转入黑洞地址（0xdead）的 USCAME 总量。来源包括卖出税销毁、退场销毁、回购销毁以及撤出 LP 销毁。"
          />
          <Metric
            title="销毁价值 (BNB)"
            value={formatBnb(data.tax_burned_token_value_bnb, 4)}
            tip="上面销毁代币按当前 LP 价格折算为 BNB 的价值，可用于估算销毁付压力。"
          />
          <Metric
            title="LP 池代币储备"
            value={formatBnb(data.pair_token_reserve, 4)}
            tip="PancakeSwap 交易对中 USCAME 一边的存量。代币减少 → 价格上涨。"
          />
          <Metric
            title="LP 池 BNB 储备"
            value={formatBnb(data.pair_bnb_reserve, 4)}
            tip="PancakeSwap 交易对中 BNB 一边的存量。入金会使 BNB 储备增加。"
          />
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
          <Metric
            title="节点看到的最新区块"
            value={data.chain_head ?? "-"}
            tip="运营服务连接的 RPC 当前返回的区块高度。反映节点与主网的同步进度。"
          />
          <Metric
            title="已索引区块"
            value={data.last_indexed_block ?? "-"}
            tip="节点已从区块链上拉取事件并写入数据库的最新区块。与「看到的最新区块」之间差距为「确认深度」。差距过大可能意味着节点落后。"
          />
          <Metric
            title="已处理事件总数"
            value={data.processed_events}
            tip="从初始化至今节点已成功识别并记录的链上事件条数（绑定、入金、转账、参数变更等）。"
          />
          <Metric
            title="已结算静态周期"
            value={data.processed_settlements}
            tip="静态收益的结算次数（默认每日 4 次）。运行中账户 × 每日结算次数 ≈ 应增长速度。"
          />
          <Metric
            title="待发起交易"
            value={data.pending_commands}
            tip="节点计算出的、尚未提交上链的交易数量（例如发静态、发节点奖、执行回购等）。正常情况下应接近 0。"
          />
          <Metric
            title="已提交待确认"
            value={data.submitted_commands}
            tip="已发出但尚未被区块确认的交易数。高负载或发生拥塞时会增长。"
          />
          <Metric
            title="已确认交易"
            value={data.confirmed_commands}
            valueStyle={{ color: "#73d13d" }}
            tip="已被区块成功确认的交易总数。该数字随业务进行持续增长。"
          />
          <Metric
            title="失败交易"
            value={data.failed_commands}
            valueStyle={{ color: "#ff7875" }}
            tip="上链后被还原或超时以致失败的交易数。可在「链下执行流水」中查看详细错误原因。"
          />
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
  tip,
}: {
  title: string;
  value: string | number;
  valueStyle?: React.CSSProperties;
  tip?: string;
}) {
  const titleNode = tip ? <HelpLabel text={title} tip={tip} /> : title;
  return (
    <Col xs={12} sm={8} md={6} xl={4}>
      <Card className="metric-card" size="small" bordered={false} style={{ background: "#171a23" }}>
        <Statistic title={titleNode} value={value} valueStyle={valueStyle} />
      </Card>
    </Col>
  );
}

function HelpLabel({ text, tip }: { text: string; tip: string }) {
  return (
    <Tooltip title={tip} placement="top">
      <span style={{ cursor: "help" }}>
        {text}
        <InfoCircleOutlined style={{ marginLeft: 4, color: "rgba(255,255,255,0.35)" }} />
      </span>
    </Tooltip>
  );
}
