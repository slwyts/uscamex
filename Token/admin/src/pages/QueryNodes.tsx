import { Card, Table, Tag, Statistic, Row, Col, Space, Button, App } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { api, apiErrorMessage, type NodesResponse } from "../utils/api";
import OwnerGate from "../components/OwnerGate";
import AddressTag from "../components/AddressTag";
import { formatBnb } from "../utils/bnb";

export default function QueryNodes() {
  return (
    <OwnerGate>
      <NodesPanel />
    </OwnerGate>
  );
}

function NodesPanel() {
  const { message } = App.useApp();
  const query = useQuery({
    queryKey: ["nodes"],
    queryFn: async () => (await api().get<NodesResponse>("/api/admin/nodes")).data,
  });
  if (query.error) message.error(apiErrorMessage(query.error));
  const totalWeight = (query.data?.items ?? []).reduce((sum, n) => sum + n.weight, 0);
  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card>
        <Row gutter={[16, 16]}>
          <Col xs={12} md={6}>
            <Statistic title="节点总数" value={query.data?.items.length ?? 0} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="权重合计" value={totalWeight} />
          </Col>
          <Col xs={24} md={12}>
            <Statistic
              title="累计节点奖励 (BNB)"
              value={formatBnb(query.data?.total_paid_bnb ?? 0, 4)}
              valueStyle={{ color: "#ffd700" }}
            />
          </Col>
        </Row>
      </Card>
      <Card
        title="节点列表"
        extra={
          <Button size="small" icon={<ReloadOutlined />} loading={query.isFetching} onClick={() => query.refetch()}>
            刷新
          </Button>
        }
      >
        <Table
          rowKey="address"
          loading={query.isFetching}
          dataSource={query.data?.items ?? []}
          pagination={false}
          size="small"
          columns={[
            { title: "节点地址", dataIndex: "address", render: (v: string) => <AddressTag value={v} full /> },
            { title: "权重", dataIndex: "weight", align: "right", width: 100 },
            {
              title: "权重占比",
              align: "right",
              width: 120,
              render: (_, row) =>
                totalWeight > 0 ? `${((row.weight / totalWeight) * 100).toFixed(2)}%` : "-",
            },
            {
              title: "已发放奖励 BNB",
              dataIndex: "paid_bnb",
              align: "right",
              width: 200,
              render: (v: string) => <Tag color="gold">{formatBnb(v, 6)}</Tag>,
            },
          ]}
        />
      </Card>
    </Space>
  );
}
