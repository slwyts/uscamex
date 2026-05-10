import { useState } from "react";
import { Card, Space, Input, Select, Table, Tag, App, Button } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { api, apiErrorMessage, type UsersListResponse, type UserSummary } from "../utils/api";
import OwnerGate from "../components/OwnerGate";
import AddressTag from "../components/AddressTag";
import { formatBnb } from "../utils/bnb";

const SORT_OPTIONS = [
  { value: "principal-desc", label: "本金 高→低" },
  { value: "principal-asc", label: "本金 低→高" },
  { value: "static-desc", label: "静态产出 高→低" },
  { value: "dynamic-desc", label: "动态产出 高→低" },
  { value: "direct-desc", label: "直推数 高→低" },
  { value: "address-asc", label: "地址 A→Z" },
];

export default function QueryUsers() {
  return (
    <OwnerGate>
      <UsersList />
    </OwnerGate>
  );
}

function UsersList() {
  const { message } = App.useApp();
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState("principal-desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const query = useQuery({
    queryKey: ["users", filter, sort, page, pageSize],
    queryFn: async () =>
      (
        await api().get<UsersListResponse>("/api/admin/users", {
          params: { filter, sort, limit: pageSize, offset: (page - 1) * pageSize },
        })
      ).data,
  });

  if (query.error) message.error(apiErrorMessage(query.error));

  return (
    <Card
      title="用户列表"
      extra={
        <Button
          size="small"
          icon={<ReloadOutlined />}
          loading={query.isFetching}
          onClick={() => query.refetch()}
        >
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
      <Table<UserSummary>
        rowKey="address"
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
          { title: "地址", dataIndex: "address", render: (v: string) => <AddressTag value={v} /> },
          {
            title: "推荐人",
            dataIndex: "referrer",
            render: (v: string | null) => (v ? <AddressTag value={v} /> : "-"),
          },
          { title: "直推", dataIndex: "direct_count", align: "right", width: 70 },
          {
            title: "本金 BNB",
            dataIndex: "principal_bnb",
            align: "right",
            width: 130,
            render: (v: string) => formatBnb(v, 4),
          },
          {
            title: "静态 BNB",
            dataIndex: "static_paid_bnb",
            align: "right",
            width: 130,
            render: (v: string) => formatBnb(v, 4),
          },
          {
            title: "动态 BNB",
            dataIndex: "dynamic_paid_bnb",
            align: "right",
            width: 130,
            render: (v: string) => formatBnb(v, 4),
          },
          {
            title: "状态",
            width: 160,
            render: (_, row) => (
              <Space size={4}>
                {row.active && <Tag color="green">活跃</Tag>}
                {row.exited && <Tag color="red">退场</Tag>}
                {row.is_node && <Tag color="gold">节点</Tag>}
              </Space>
            ),
          },
        ]}
      />
    </Card>
  );
}
