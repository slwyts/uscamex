import { useState } from "react";
import { Card, Table, Tag, Space, Select, Statistic, Row, Col, Button, Tooltip, App, Popconfirm } from "antd";
import { ReloadOutlined, RedoOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  apiErrorMessage,
  retryFailedCommands,
  type JournalListResponse,
  type JournalEntry,
} from "../utils/api";
import OwnerGate from "../components/OwnerGate";

const STATUS_OPTIONS = [
  { value: "", label: "全部状态" },
  { value: "pending", label: "待执行" },
  { value: "submitted", label: "已提交" },
  { value: "confirmed", label: "已确认" },
  { value: "failed", label: "失败" },
];

const STATUS_COLOR: Record<string, string> = {
  pending: "default",
  submitted: "blue",
  confirmed: "green",
  failed: "red",
};

// 业务类型（journal kind）中文映射。命名沿用 origin.md 规格术语。
const KIND_LABEL: Record<string, { text: string; tip: string }> = {
  "deposit-batch": {
    text: "入金分配（原子）",
    tip: "一笔入金的完整分配（组建 LP + 联合建设者买入 + 回购仓库注资 + 节点分红 + 直推奖励）在单笔原子交易中执行，要么全部成功要么整体回滚，杜绝部分执行与重复打款。",
  },
  "add-liquidity": {
    text: "组建 LP",
    tip: "入金 60% 用于组建流动性：先用一半 BNB 买入项目代币，再与剩余 BNB 一同注入 LP 底池。",
  },
  node: {
    text: "节点分红",
    tip: "入金 10% 按权重平均分配给所有节点地址（BNB）。",
  },
  "direct-referral": {
    text: "直推奖励",
    tip: "入金 10% 直接发放给直接推荐人（BNB 实时到账）。",
  },
  "builder-buy": {
    text: "联合建设者分红池买入",
    tip: "入金 10% 用于从 LP 底池买入项目代币，所得代币留存于合约自身（联合建设者分红池）。",
  },
  "credit-vault": {
    text: "回购销毁仓库注资",
    tip: "入金 10% 的 BNB 直接转入回购销毁仓库子合约，作为后续回购资金。",
  },
  "pull-pair-tokens": {
    text: "LP 底池通缩",
    tip: "每小时从 LP 底池单边抽取项目代币（默认 0.1%/次，每日上限 2%），转入联合建设者分红池，推动价格上行。",
  },
  buyback: {
    text: "回购销毁",
    tip: "回购销毁仓库每分钟用其持有的 BNB 从 DEX 买入项目代币并销毁至黑洞。",
  },
  "pay-reward-token": {
    text: "收益发放",
    tip: "向用户发放静态收益与团队代数奖励（按当时代币价格折算等值代币，每 6 小时一次）。",
  },
  "redeem-user-lp": {
    text: "撤出 LP 退款",
    tip: "用户撤出 / 出局时，销毁其 LP 项目代币份额，仅退回对应的 BNB 份额。",
  },
  "sweep-tax-to-bnb": {
    text: "税费清算",
    tip: "将买/卖税累积在合约的项目代币按规则处理：部分留存分红池、部分兑换 BNB 转入生态基金与回购仓库、剩余销毁。",
  },
  "exit-burn": {
    text: "出局销毁",
    tip: "出局时销毁用户持有的项目代币份额至黑洞地址。",
  },
  "exit-refund": {
    text: "出局退款",
    tip: "出局时将对应的 BNB 份额退回用户。",
  },
  "exit-position": {
    text: "出局处理（遗留）",
    tip: "旧版合并出局指令，现已拆分为出局销毁与出局退款，不再使用。",
  },
};

function kindLabel(kind: string): { text: string; tip: string } {
  return KIND_LABEL[kind] ?? { text: kind, tip: kind };
}

const STATUS_TEXT: Record<string, string> = {
  pending: "待执行",
  submitted: "已提交",
  confirmed: "已确认",
  failed: "失败",
};

export default function QueryJournal() {
  return (
    <OwnerGate>
      <JournalPanel />
    </OwnerGate>
  );
}

function JournalPanel() {
  const { message } = App.useApp();
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [retrying, setRetrying] = useState(false);
  const query = useQuery({
    queryKey: ["journal-list", status, page, pageSize],
    queryFn: async () =>
      (
        await api().get<JournalListResponse>("/api/admin/journal-list", {
          params: { status, limit: pageSize, offset: (page - 1) * pageSize },
        })
      ).data,
    refetchInterval: 15_000,
  });
  if (query.error) message.error(apiErrorMessage(query.error));

  const failedCount = query.data?.counts.failed ?? 0;
  const handleRetry = async () => {
    setRetrying(true);
    try {
      const res = await retryFailedCommands();
      if (res.retried === 0) {
        message.info("没有需要重试的失败命令");
      } else {
        message.success(`已重新入队 ${res.retried} 条命令，本次提交成功 ${res.tx_hashes.length} 笔`);
      }
      await query.refetch();
    } catch (err) {
      message.error(apiErrorMessage(err));
    } finally {
      setRetrying(false);
    }
  };

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      {query.data && (
        <Card>
          <Row gutter={[16, 16]}>
            <Col xs={12} md={6}>
              <Statistic title="待执行" value={query.data.counts.pending} />
            </Col>
            <Col xs={12} md={6}>
              <Statistic title="已提交" value={query.data.counts.submitted} />
            </Col>
            <Col xs={12} md={6}>
              <Statistic title="已确认" value={query.data.counts.confirmed} valueStyle={{ color: "#73d13d" }} />
            </Col>
            <Col xs={12} md={6}>
              <Statistic title="失败" value={query.data.counts.failed} valueStyle={{ color: "#ff7875" }} />
            </Col>
          </Row>
        </Card>
      )}
      <Card
        title="链下执行流水"
        extra={
          <Space>
            <Popconfirm
              title="重试全部失败命令"
              description={`将把 ${failedCount} 条失败命令的尝试次数清零并立即重新提交。请确认链上前置条件（如买入开放）已满足。`}
              okText="确认重试"
              cancelText="取消"
              disabled={failedCount === 0}
              onConfirm={handleRetry}
            >
              <Button
                size="small"
                danger
                icon={<RedoOutlined />}
                loading={retrying}
                disabled={failedCount === 0}
              >
                重试失败命令{failedCount > 0 ? `（${failedCount}）` : ""}
              </Button>
            </Popconfirm>
            <Button size="small" icon={<ReloadOutlined />} loading={query.isFetching} onClick={() => query.refetch()}>
              刷新
            </Button>
          </Space>
        }
      >
        <Space style={{ marginBottom: 12 }}>
          <Select
            value={status}
            onChange={(value) => {
              setStatus(value);
              setPage(1);
            }}
            style={{ width: 160 }}
            options={STATUS_OPTIONS}
          />
        </Space>
        <Table<JournalEntry>
          rowKey="id"
          loading={query.isFetching}
          dataSource={query.data?.items ?? []}
          size="small"
          pagination={{
            current: page,
            pageSize,
            total: query.data?.total ?? 0,
            showSizeChanger: true,
            onChange: (next, size) => {
              setPage(next);
              setPageSize(size);
            },
          }}
          columns={[
            {
              title: "ID",
              dataIndex: "id",
              ellipsis: true,
              render: (v: string) => (
                <Tooltip title={v}>
                  <span className="address-mono">{v}</span>
                </Tooltip>
              ),
            },
            {
              title: "业务类型",
              dataIndex: "kind",
              width: 180,
              render: (v: string) => {
                const { text, tip } = kindLabel(v);
                return (
                  <Tooltip title={`${tip}（原始标识：${v}）`}>
                    <span style={{ cursor: "help" }}>{text}</span>
                  </Tooltip>
                );
              },
            },
            {
              title: "状态",
              dataIndex: "status",
              width: 110,
              render: (v: string) => (
                <Tag color={STATUS_COLOR[v] ?? "default"}>{STATUS_TEXT[v] ?? v}</Tag>
              ),
            },
            { title: "尝试次数", dataIndex: "attempts", width: 90, align: "right" },
            {
              title: "交易哈希",
              dataIndex: "tx_hash",
              width: 200,
              render: (v: string | null) =>
                v ? (
                  <Tooltip title={v}>
                    <span className="address-mono">{v.slice(0, 10)}…{v.slice(-6)}</span>
                  </Tooltip>
                ) : (
                  "-"
                ),
            },
            {
              title: "错误信息",
              dataIndex: "error",
              ellipsis: true,
              render: (v: string | null) => (v ? <span style={{ color: "#ff7875" }}>{v}</span> : "-"),
            },
          ]}
          expandable={{
            expandedRowRender: (record) => (
              <pre style={{ margin: 0, background: "#0d0e13", padding: 12, borderRadius: 8 }}>
                {JSON.stringify(record.payload, null, 2)}
              </pre>
            ),
          }}
        />
      </Card>
    </Space>
  );
}
