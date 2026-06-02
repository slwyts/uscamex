import { useEffect, useState } from "react";
import { Button, Card, Descriptions, Drawer, Input, Select, Space, Spin, Table, Tag, App } from "antd";
import { ReloadOutlined, SearchOutlined, UserOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  apiErrorMessage,
  type UserDetailResponse,
  type UsersListResponse,
  type UserSummary,
} from "../utils/api";
import OwnerGate from "../components/OwnerGate";
import AddressTag from "../components/AddressTag";
import { UserTable } from "./QueryTeam";
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
  const [quickAddress, setQuickAddress] = useState("");
  const [selectedAddress, setSelectedAddress] = useState("");
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

  const detailQuery = useQuery({
    queryKey: ["user-detail", selectedAddress],
    enabled: !!selectedAddress,
    queryFn: async () =>
      (await api().get<UserDetailResponse>("/api/admin/user", { params: { address: selectedAddress } })).data,
  });

  useEffect(() => {
    if (query.error) message.error(apiErrorMessage(query.error));
  }, [message, query.error]);

  useEffect(() => {
    if (detailQuery.error) message.error(apiErrorMessage(detailQuery.error));
  }, [detailQuery.error, message]);

  const openUser = (address: string) => {
    const next = address.trim().toLowerCase();
    if (!next) return;
    setSelectedAddress(next);
    setQuickAddress(next);
  };

  return (
    <>
      <Card
        title="用户列表与详情"
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
            placeholder="按地址子串过滤列表"
            allowClear
            style={{ width: 300 }}
            onSearch={(value) => {
              setFilter(value.trim().toLowerCase());
              setPage(1);
            }}
          />
          <Input.Search
            placeholder="输入完整地址查看详情"
            allowClear
            value={quickAddress}
            onChange={(event) => setQuickAddress(event.target.value)}
            onSearch={openUser}
            enterButton={<SearchOutlined />}
            style={{ width: 360 }}
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
          onRow={(row) => ({
            onClick: () => openUser(row.address),
          })}
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
            {
              title: "操作",
              width: 90,
              render: (_, row) => (
                <Button
                  size="small"
                  icon={<UserOutlined />}
                  onClick={(event) => {
                    event.stopPropagation();
                    openUser(row.address);
                  }}
                >
                  详情
                </Button>
              ),
            },
          ]}
        />
      </Card>
      <Drawer
        title="用户详情"
        open={!!selectedAddress}
        onClose={() => setSelectedAddress("")}
        width={820}
        destroyOnClose
      >
        {detailQuery.isFetching && !detailQuery.data ? (
          <Spin />
        ) : detailQuery.data ? (
          <UserDetailPanel data={detailQuery.data} onOpenUser={openUser} />
        ) : null}
      </Drawer>
    </>
  );
}

function UserDetailPanel({
  data,
  onOpenUser,
}: {
  data: UserDetailResponse;
  onOpenUser: (address: string) => void;
}) {
  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Descriptions bordered column={{ xs: 1, sm: 2 }} size="small">
        <Descriptions.Item label="地址" span={2}>
          <AddressTag value={data.summary.address} full />
        </Descriptions.Item>
        <Descriptions.Item label="推荐人">
          {data.referrer_summary ? (
            <Button type="link" onClick={() => onOpenUser(data.referrer_summary!.address)} style={{ padding: 0 }}>
              <AddressTag value={data.referrer_summary.address} />
            </Button>
          ) : (
            <Tag>无 / 根</Tag>
          )}
        </Descriptions.Item>
        <Descriptions.Item label="直推数量">{data.summary.direct_count}</Descriptions.Item>
        <Descriptions.Item label="持仓 ID">{data.summary.position_id}</Descriptions.Item>
        <Descriptions.Item label="本金 BNB">{formatBnb(data.summary.principal_bnb, 6)}</Descriptions.Item>
        <Descriptions.Item label="静态产出 BNB">{formatBnb(data.summary.static_paid_bnb, 6)}</Descriptions.Item>
        <Descriptions.Item label="动态产出 BNB">{formatBnb(data.summary.dynamic_paid_bnb, 6)}</Descriptions.Item>
        <Descriptions.Item label="节点身份">
          {data.summary.is_node ? (
            <Tag color="gold">节点 · 权重 {data.summary.node_weight}</Tag>
          ) : (
            <Tag>普通用户</Tag>
          )}
        </Descriptions.Item>
        <Descriptions.Item label="节点累计领取 BNB">
          {formatBnb(data.summary.node_paid_bnb, 6)}
        </Descriptions.Item>
        <Descriptions.Item label="直推奖累计 BNB">
          {formatBnb(data.summary.direct_paid_bnb, 6)}
        </Descriptions.Item>
        <Descriptions.Item label="状态" span={2}>
          <Space>
            {data.summary.active && <Tag color="green">活跃</Tag>}
            {data.summary.exited && <Tag color="red">已退场</Tag>}
            {!data.summary.active && !data.summary.exited && <Tag>未激活</Tag>}
          </Space>
        </Descriptions.Item>
      </Descriptions>
      <Card title={`直推用户 (${data.direct_members.length})`} size="small">
        <UserTable items={data.direct_members} />
      </Card>
    </Space>
  );
}
