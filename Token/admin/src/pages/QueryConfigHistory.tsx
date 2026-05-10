import { Card, Table, Button, Space, App, Tag } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { api, apiErrorMessage, type ConfigHistoryResponse, type ConfigHistoryItem } from "../utils/api";
import OwnerGate from "../components/OwnerGate";

export default function QueryConfigHistory() {
  return (
    <OwnerGate>
      <HistoryPanel />
    </OwnerGate>
  );
}

function HistoryPanel() {
  const { message } = App.useApp();
  const query = useQuery({
    queryKey: ["config-history"],
    queryFn: async () =>
      (await api().get<ConfigHistoryResponse>("/api/admin/config-history", { params: { limit: 50 } })).data,
  });
  if (query.error) message.error(apiErrorMessage(query.error));
  return (
    <Card
      title="链下配置镜像历史（每次扫描会写入一份）"
      extra={
        <Button size="small" icon={<ReloadOutlined />} loading={query.isFetching} onClick={() => query.refetch()}>
          刷新
        </Button>
      }
    >
      <Table<ConfigHistoryItem>
        rowKey="id"
        loading={query.isFetching}
        dataSource={query.data?.items ?? []}
        size="small"
        pagination={false}
        columns={[
          { title: "ID", dataIndex: "id", width: 80 },
          {
            title: "时间",
            dataIndex: "created_at",
            width: 220,
            render: (v: string) => <Space>{v}</Space>,
          },
          {
            title: "区块",
            dataIndex: "block_number",
            width: 110,
            render: (v: number | null | undefined) => (v ? <Tag color="blue">{v}</Tag> : <span style={{ color: "#888" }}>—</span>),
          },
          {
            title: "Tx",
            dataIndex: "tx_hash",
            width: 200,
            render: (v: string | null | undefined) =>
              v ? (
                <a href={`https://bscscan.com/tx/${v}`} target="_blank" rel="noreferrer" style={{ fontFamily: "monospace" }}>
                  {`${v.slice(0, 10)}…${v.slice(-6)}`}
                </a>
              ) : (
                <span style={{ color: "#888" }}>—</span>
              ),
          },
          {
            title: "来源",
            dataIndex: "updated_by",
            width: 200,
            render: (v: string) => <Tag color={v.startsWith("chain-event:") ? "green" : "default"}>{v}</Tag>,
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
  );
}
