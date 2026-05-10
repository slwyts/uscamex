import { useState } from "react";
import { Card, Table, Tag, Space, Input, Select, Button, App } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { api, apiErrorMessage, type PositionsResponse, type PositionItem } from "../utils/api";
import OwnerGate from "../components/OwnerGate";
import AddressTag from "../components/AddressTag";
import { formatBnb } from "../utils/bnb";

const SORT_OPTIONS = [
  { value: "position-desc", label: "持仓 ID 新→旧" },
  { value: "principal-desc", label: "本金 高→低" },
  { value: "principal-asc", label: "本金 低→高" },
];

export default function QueryPositions() {
  return (
    <OwnerGate>
      <PositionsPanel />
    </OwnerGate>
  );
}

function PositionsPanel() {
  const { message } = App.useApp();
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState("position-desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const query = useQuery({
    queryKey: ["positions", filter, sort, page, pageSize],
    queryFn: async () =>
      (
        await api().get<PositionsResponse>("/api/admin/positions", {
          params: { filter, sort, limit: pageSize, offset: (page - 1) * pageSize },
        })
      ).data,
  });
  if (query.error) message.error(apiErrorMessage(query.error));
  return (
    <Card
      title="持仓清单"
      extra={
        <Button size="small" icon={<ReloadOutlined />} loading={query.isFetching} onClick={() => query.refetch()}>
          刷新
        </Button>
      }
    >
      <Space style={{ marginBottom: 12 }} wrap>
        <Input.Search
          placeholder="按地址子串过滤"
          allowClear
          style={{ width: 320 }}
          onSearch={(value) => {
            setFilter(value.trim().toLowerCase());
            setPage(1);
          }}
        />
        <Select
          value={sort}
          onChange={(value) => {
            setSort(value);
            setPage(1);
          }}
          style={{ width: 200 }}
          options={SORT_OPTIONS}
        />
      </Space>
      <Table<PositionItem>
        rowKey={(record) => `${record.user}:${record.position_id}`}
        loading={query.isFetching}
        size="small"
        dataSource={query.data?.items ?? []}
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
          { title: "用户", dataIndex: "user", render: (v: string) => <AddressTag value={v} /> },
          { title: "持仓 ID", dataIndex: "position_id", width: 90, align: "right" },
          {
            title: "本金 BNB",
            dataIndex: "principal_bnb",
            width: 140,
            align: "right",
            render: (v: string) => formatBnb(v, 4),
          },
          {
            title: "静态 BNB",
            dataIndex: "static_paid_bnb",
            width: 140,
            align: "right",
            render: (v: string) => formatBnb(v, 4),
          },
          {
            title: "动态 BNB",
            dataIndex: "dynamic_paid_bnb",
            width: 140,
            align: "right",
            render: (v: string) => formatBnb(v, 4),
          },
          {
            title: "状态",
            width: 130,
            render: (_, row) => (
              <Space size={4}>
                {row.active && <Tag color="green">活跃</Tag>}
                {row.exited && <Tag color="red">已退场</Tag>}
              </Space>
            ),
          },
        ]}
      />
    </Card>
  );
}
