import { Card, Col, Row, Statistic, Tag, Spin, Empty, Space, Button, App, Tooltip } from "antd";
import { InfoCircleOutlined } from "@ant-design/icons";
import {
  ClusterOutlined,
  CrownOutlined,
  GlobalOutlined,
  ReloadOutlined,
  TeamOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { api, apiErrorMessage, type GlobalStats, type PublicHealth } from "../utils/api";
import OwnerGate from "../components/OwnerGate";
import AddressTag from "../components/AddressTag";
import { formatBnb } from "../utils/bnb";
import { bpsToPercentText } from "../utils/bps";

function dayToDate(day: number): string {
  const d = new Date(day * 86_400_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

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
          <Metric
            title="链 ID"
            value={data.chain_id}
            tip="当前节点连接的区块链网络编号。56 = BSC 主网；97 = BSC 测试网。请确认与钱包侧的网络一致。"
          />
          <Metric
            title="最新区块"
            value={data.chain_head ?? "-"}
            tip="RPC 当前返回的链上最新区块高度，反映节点与全网的同步进度。"
          />
          <Metric
            title="索引起始区块"
            value={data.indexer_start_block}
            tip="后台从该区块开始扫描事件。通常是合约部署的区块；调小会重新拉取历史，调大会跳过更早的事件。"
          />
          <Metric
            title="区块确认数"
            value={data.confirmations}
            tip="后台等待多少个区块确认后才认为事件最终生效，用于抵御短暂回滚。BSC 一般 3~12。"
          />
          <Col span={24}>
            <div className="overview-identity">
              <span>
                <span className="label">代币合约：</span>
                <AddressTag value={data.token_address} full />
              </span>
              <span>
                <span className="label">PancakeSwap 路由：</span>
                <AddressTag value={data.pancake_v2_router} full />
              </span>
            </div>
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
    refetchInterval: 45_000,
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
            <CrownOutlined /> 协议状态
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
        <div className="overview-identity">
          <span>
            <span className="label">推荐根：</span>
            <AddressTag value={data.root} />
          </span>
          <span>
            <span className="label">协议参数：</span>
            <Tag color={data.protocol_config_initialized ? "green" : "red"}>
              {data.protocol_config_initialized ? "已初始化" : "尚未初始化"}
            </Tag>
          </span>
          <span>
            <span className="label">当前业务日：</span>{data.current_day ? dayToDate(data.current_day) : "-"}
          </span>
          <span>
            <span className="label">今日通缩：</span>
            {bpsToPercentText(data.deflation_used_bps)}%
          </span>
        </div>
      </Card>

      <Card
        className="section-card"
        title={
          <Space>
            <TeamOutlined /> 用户规模
          </Space>
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
            tone="good"
            tip="已完成入金、仓位仍在产出静态/动态收益的账户数。出局或主动撤出 LP 后不计在内。"
          />
          <Metric
            title="已出局账户"
            value={data.exited_users}
            tone="warn"
            tip="静态+动态收益累计达到入金本金 N 倍（默认 3 倍）后自动出局，或主动撤出 LP 后停止产出的账户数。重新入金后会重新计入「运行中账户」。"
          />
          <Metric
            title="节点数量"
            value={data.nodes_count}
            tip="在「节点配置」中登记且权重 > 0 的地址数量。入金 10% 的节点分红按权重平均分配给所有节点。"
          />
        </Row>
      </Card>

      <Card
        className="section-card"
        title={
          <Space>
            <ThunderboltOutlined /> 资金水位
          </Space>
        }
      >
        <Row gutter={[16, 16]}>
          <Metric
            title="用户累计入金 (BNB)"
            value={formatBnb(data.total_principal_bnb, 4)}
            tip="全体用户向合约发送 BNB 作为 LP 入金本金的累计总额（不含出局/撤出后退回部分）。"
          />
          <Metric
            title="累计静态产出 (BNB)"
            value={formatBnb(data.total_static_paid_bnb, 4)}
            tip="按每日静态收益率（默认 0.8%，每 6 小时发放一次）折算为 BNB 的累计发放金额，反映项目的总兑付压力。"
          />
          <Metric
            title="累计动态产出 (BNB)"
            value={formatBnb(data.total_dynamic_paid_bnb, 4)}
            tip="直推奖励（默认 10%）与 10 代团队奖励的累计发放金额（BNB 金本位）。与静态产出一起计入出局倍数。"
          />
          <Metric
            title="回购销毁仓库余额 (BNB)"
            value={formatBnb(data.vault_bnb, 4)}
            tip="回购销毁仓库是 Token 合约部署的子合约，持有用于回购的 BNB。资金来自买入税、卖出税与入金 10% 划转，启动后每分钟从市场买回代币并销毁至黑洞。"
          />
          <Metric
            title="生态建设基金 BNB"
            value={formatBnb(data.owner_bnb, 4)}
            tip="生态建设基金即合约 owner() 地址。卖出税中归属生态基金的 BNB（默认 3%）会直接转入该地址。"
          />
          <Metric
            title="联合建设者分红池价值 (BNB)"
            value={formatBnb(data.builder_token_value_bnb, 4)}
            tip="联合建设者分红池即合约自身地址所持的项目代币，按当前 LP 价格折算的 BNB 价值。代币来自买入税、卖出税与每小时 LP 通缩抽取。"
          />
          <Metric
            title="联合建设者分红池代币数量"
            value={formatBnb(data.builder_token_amount, 4)}
            tip="联合建设者分红池（合约自身地址）所持项目代币数量（未折算价格），可在「资产提取」中划转。"
          />
          <Metric
            title="累计销毁代币数量"
            value={formatBnb(data.burned_tokens, 4)}
            tip="转入黑洞地址（0xdead）的项目代币总量。来源包括卖出税销毁、出局销毁、回购销毁以及撤出 LP 销毁。"
          />
          <Metric
            title="销毁价值 (BNB)"
            value={formatBnb(data.tax_burned_token_value_bnb, 4)}
            tip="上述销毁代币按当前 LP 价格折算为 BNB 的价值，可用于估算累计销毁规模。"
          />
          <Metric
            title="LP 池代币储备"
            value={formatBnb(data.pair_token_reserve, 4)}
            tip="PancakeSwap 交易对中项目代币一侧的存量。代币减少 → 价格上涨（通缩机制依此驱动）。"
          />
          <Metric
            title="LP 池 BNB 储备"
            value={formatBnb(data.pair_bnb_reserve, 4)}
            tip="PancakeSwap 交易对中 BNB 一侧的存量。入金组建 LP 会使 BNB 储备增加。"
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
            tone="good"
            tip="已被区块成功确认的交易总数。该数字随业务进行持续增长。"
          />
          <Metric
            title="失败交易"
            value={data.failed_commands}
            tone="warn"
            tip="上链后被还原或超时以致失败的交易数。可在「链下执行流水」中查看详细错误原因。"
          />
        </Row>
      </Card>
    </Space>
  );
}

function Metric({
  title,
  value,
  tone,
  tip,
}: {
  title: string;
  value: string | number;
  tone?: "good" | "warn";
  tip?: string;
}) {
  const titleNode = tip ? <HelpLabel text={title} tip={tip} /> : title;
  const toneClass = tone === "good" ? " metric-good" : tone === "warn" ? " metric-warn" : "";
  return (
    <Col xs={12} sm={12} md={8} lg={6}>
      <Card className={`metric-card${toneClass}`} size="small" bordered={false}>
        <Statistic title={titleNode} value={value} />
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
