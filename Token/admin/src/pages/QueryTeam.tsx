import { useState } from "react";
import {
  Card,
  Space,
  Input,
  InputNumber,
  Button,
  Table,
  Tag,
  Statistic,
  Row,
  Col,
  Collapse,
  App,
} from "antd";
import { SearchOutlined, BranchesOutlined } from "@ant-design/icons";
import { useMutation } from "@tanstack/react-query";
import { api, apiErrorMessage, type TeamResponse, type UserSummary } from "../utils/api";
import OwnerGate from "../components/OwnerGate";
import AddressTag from "../components/AddressTag";
import { formatBnb } from "../utils/bnb";

export default function QueryTeam() {
  return (
    <OwnerGate>
      <TeamExplorer />
    </OwnerGate>
  );
}

function TeamExplorer() {
  const { message } = App.useApp();
  const [address, setAddress] = useState("");
  const [depth, setDepth] = useState(10);
  const [data, setData] = useState<TeamResponse | null>(null);
  const mutation = useMutation({
    mutationFn: async () => {
      const params = { address, depth };
      const response = await api().get<TeamResponse>("/api/admin/team", { params });
      return response.data;
    },
    onSuccess: (value) => setData(value),
    onError: (error) => message.error(apiErrorMessage(error)),
  });

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card title={<Space><BranchesOutlined /> 团队结构查询</Space>}>
        <Space wrap>
          <Input
            placeholder="任意地址 0x..."
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            style={{ width: 360 }}
            allowClear
          />
          <InputNumber
            min={1}
            max={50}
            value={depth}
            onChange={(value) => setDepth(Number(value || 10))}
            addonBefore="深度"
            style={{ width: 140 }}
          />
          <Button
            type="primary"
            icon={<SearchOutlined />}
            loading={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            查询
          </Button>
        </Space>
      </Card>
      {data && (
        <Card>
          <Row gutter={[16, 16]}>
            <Col xs={12} md={6}>
              <Statistic title="总下线人数" value={data.total_descendants} />
            </Col>
            <Col xs={12} md={6}>
              <Statistic title="直推数量" value={data.direct_members.length} />
            </Col>
            <Col xs={12} md={6}>
              <Statistic title="层级数" value={data.generations.length} />
            </Col>
            <Col xs={12} md={6}>
              <Statistic title="读取深度" value={data.truncated_at_depth} />
            </Col>
            <Col xs={24}>
              <RootCard summary={data.root} />
            </Col>
          </Row>
        </Card>
      )}
      {data && (
        <Card title="直推用户">
          <UserTable items={data.direct_members} />
        </Card>
      )}
      {data && data.generations.length > 0 && (
        <Card title="按代分组">
          <Collapse
            defaultActiveKey={data.generations.map((g) => String(g.generation))}
            items={data.generations.map((group) => ({
              key: String(group.generation),
              label: (
                <Space>
                  <Tag color="gold">第 {group.generation} 代</Tag>
                  <span>{group.count} 人</span>
                </Space>
              ),
              children: <UserTable items={group.members} />,
            }))}
          />
        </Card>
      )}
    </Space>
  );
}

function RootCard({ summary }: { summary: UserSummary }) {
  return (
    <Card size="small" style={{ background: "#171a23" }}>
      <Row gutter={[16, 16]}>
        <Col xs={24} md={10}>
          <div style={{ color: "rgba(255,255,255,0.55)", fontSize: 12 }}>查询地址</div>
          <AddressTag value={summary.address} full />
        </Col>
        <Col xs={12} md={4}>
          <Statistic title="直推" value={summary.direct_count} />
        </Col>
        <Col xs={12} md={5}>
          <Statistic title="本金 (BNB)" value={formatBnb(summary.principal_bnb, 4)} />
        </Col>
        <Col xs={12} md={5}>
          <Statistic title="静态产出 (BNB)" value={formatBnb(summary.static_paid_bnb, 4)} />
        </Col>
      </Row>
    </Card>
  );
}

export function UserTable({ items }: { items: UserSummary[] }) {
  return (
    <Table<UserSummary>
      rowKey="address"
      dataSource={items}
      pagination={items.length > 20 ? { pageSize: 20, showSizeChanger: true } : false}
      size="small"
      columns={[
        {
          title: "地址",
          dataIndex: "address",
          render: (value: string) => <AddressTag value={value} />,
        },
        {
          title: "推荐人",
          dataIndex: "referrer",
          render: (value: string | null) => (value ? <AddressTag value={value} /> : <span style={{ color: "rgba(255,255,255,0.4)" }}>-</span>),
        },
        {
          title: "直推",
          dataIndex: "direct_count",
          width: 70,
          align: "right",
        },
        {
          title: "本金 BNB",
          dataIndex: "principal_bnb",
          width: 130,
          align: "right",
          render: (value: string) => formatBnb(value, 4),
        },
        {
          title: "静态产出 BNB",
          dataIndex: "static_paid_bnb",
          width: 140,
          align: "right",
          render: (value: string) => formatBnb(value, 4),
        },
        {
          title: "动态产出 BNB",
          dataIndex: "dynamic_paid_bnb",
          width: 140,
          align: "right",
          render: (value: string) => formatBnb(value, 4),
        },
        {
          title: "状态",
          width: 120,
          render: (_, row) => (
            <Space size={4}>
              {row.active && <Tag color="green">活跃</Tag>}
              {row.exited && <Tag color="red">已退场</Tag>}
              {row.is_node && <Tag color="gold">节点 W{row.node_weight}</Tag>}
            </Space>
          ),
        },
      ]}
    />
  );
}
