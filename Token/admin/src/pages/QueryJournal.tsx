import { useState } from "react";
import { Card, Table, Tag, Space, Select, Statistic, Row, Col, Button, Tooltip, App } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { api, apiErrorMessage, type JournalListResponse, type JournalEntry } from "../utils/api";
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
          <Button size="small" icon={<ReloadOutlined />} loading={query.isFetching} onClick={() => query.refetch()}>
            刷新
          </Button>
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
            { title: "业务类型", dataIndex: "kind", width: 160 },
            {
              title: "状态",
              dataIndex: "status",
              width: 110,
              render: (v: string) => <Tag color={STATUS_COLOR[v] ?? "default"}>{v}</Tag>,
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
