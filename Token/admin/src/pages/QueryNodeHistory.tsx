import { useMemo, useState } from "react";
import {
  Card,
  Table,
  Button,
  App,
  Tag,
  Input,
  Space,
  Select,
  Statistic,
  Row,
  Col,
  Empty,
  Tooltip,
} from "antd";
import { ReloadOutlined, RiseOutlined, FallOutlined, MinusOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { api, apiErrorMessage, type NodeHistoryResponse, type NodeHistoryItem } from "../utils/api";
import OwnerGate from "../components/OwnerGate";
import AddressTag from "../components/AddressTag";

type Direction = "up" | "down" | "same" | "remove" | "add";

interface DecoratedRow extends NodeHistoryItem {
  previousWeight: number | null;
  direction: Direction;
}

export default function QueryNodeHistory() {
  return (
    <OwnerGate>
      <NodeHistoryPanel />
    </OwnerGate>
  );
}

function NodeHistoryPanel() {
  const { message } = App.useApp();
  const [filterAddress, setFilterAddress] = useState<string>("");
  const [sourceFilter, setSourceFilter] = useState<"all" | "chain" | "manual">("all");
  const [limit, setLimit] = useState<number>(200);

  const query = useQuery({
    queryKey: ["node-history", limit],
    queryFn: async () =>
      (
        await api().get<NodeHistoryResponse>("/api/admin/node-history", {
          params: { limit },
        })
      ).data,
  });
  if (query.error) message.error(apiErrorMessage(query.error));

  const allItems = query.data?.items ?? [];

  const decorated: DecoratedRow[] = useMemo(() => {
    // backend returns DESC by id; iterate ascending so we can compute the
    // previous weight per node, then re-sort DESC for display.
    const ascending = [...allItems].sort((a, b) => a.id - b.id);
    const lastWeightByNode = new Map<string, number>();
    const built: DecoratedRow[] = [];
    for (const row of ascending) {
      const addr = row.node_address.toLowerCase();
      const prev = lastWeightByNode.get(addr);
      let direction: Direction;
      if (prev === undefined) {
        direction = row.weight === 0 ? "remove" : "add";
      } else if (row.weight === 0) {
        direction = "remove";
      } else if (row.weight > prev) {
        direction = "up";
      } else if (row.weight < prev) {
        direction = "down";
      } else {
        direction = "same";
      }
      built.push({ ...row, previousWeight: prev ?? null, direction });
      lastWeightByNode.set(addr, row.weight);
    }
    return built.sort((a, b) => b.id - a.id);
  }, [allItems]);

  const filtered = useMemo(() => {
    const addr = filterAddress.trim().toLowerCase();
    return decorated.filter((row) => {
      if (addr && !row.node_address.toLowerCase().includes(addr)) return false;
      if (sourceFilter === "chain" && !row.updated_by.startsWith("chain-event:")) return false;
      if (sourceFilter === "manual" && row.updated_by.startsWith("chain-event:")) return false;
      return true;
    });
  }, [decorated, filterAddress, sourceFilter]);

  const stats = useMemo(() => {
    const uniqueNodes = new Set(allItems.map((row) => row.node_address.toLowerCase()));
    const chainEvents = allItems.filter((row) => row.updated_by.startsWith("chain-event:")).length;
    const removals = allItems.filter((row) => row.weight === 0).length;
    return {
      total: allItems.length,
      uniqueNodes: uniqueNodes.size,
      chainEvents,
      removals,
    };
  }, [allItems]);

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card>
        <Row gutter={[16, 16]}>
          <Col xs={12} md={6}>
            <Statistic title="历史条目" value={stats.total} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="涉及节点" value={stats.uniqueNodes} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic
              title="链上事件触发"
              value={stats.chainEvents}
              valueStyle={{ color: "#52c41a" }}
            />
          </Col>
          <Col xs={12} md={6}>
            <Statistic
              title="移除次数 (weight=0)"
              value={stats.removals}
              valueStyle={{ color: "#ff4d4f" }}
            />
          </Col>
        </Row>
      </Card>

      <Card
        title="节点权重变更历史（链上事件即时镜像）"
        extra={
          <Space wrap>
            <Input.Search
              allowClear
              size="small"
              placeholder="按节点地址过滤（部分匹配）"
              style={{ width: 320 }}
              value={filterAddress}
              onChange={(e) => setFilterAddress(e.target.value)}
            />
            <Select
              size="small"
              value={sourceFilter}
              onChange={setSourceFilter}
              style={{ width: 140 }}
              options={[
                { value: "all", label: "全部来源" },
                { value: "chain", label: "仅链上事件" },
                { value: "manual", label: "仅手动/启动" },
              ]}
            />
            <Select
              size="small"
              value={limit}
              onChange={setLimit}
              style={{ width: 110 }}
              options={[100, 200, 500].map((value) => ({
                value,
                label: `最近 ${value}`,
              }))}
            />
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={query.isFetching}
              onClick={() => query.refetch()}
            >
              刷新
            </Button>
          </Space>
        }
      >
        <Table<DecoratedRow>
          rowKey="id"
          loading={query.isFetching}
          dataSource={filtered}
          size="small"
          pagination={{ pageSize: 25, showSizeChanger: true }}
          locale={{ emptyText: <Empty description="无匹配的历史" /> }}
          columns={[
            { title: "ID", dataIndex: "id", width: 80 },
            {
              title: "时间",
              dataIndex: "created_at",
              width: 190,
            },
            {
              title: "节点",
              dataIndex: "node_address",
              width: 220,
              render: (v: string) => <AddressTag value={v} />,
            },
            {
              title: "变化",
              key: "direction",
              width: 110,
              render: (_, row) => <DirectionTag row={row} />,
            },
            {
              title: "权重",
              dataIndex: "weight",
              width: 150,
              align: "right",
              render: (v: number, row) => (
                <Tooltip
                  title={
                    row.previousWeight === null
                      ? "首次记录"
                      : `上一条权重：${row.previousWeight}`
                  }
                >
                  <span>
                    {row.previousWeight !== null && row.previousWeight !== v && (
                      <span style={{ color: "rgba(255,255,255,0.4)", marginRight: 6 }}>
                        {row.previousWeight} →
                      </span>
                    )}
                    {v === 0 ? <Tag color="red">移除</Tag> : <Tag color="purple">{v}</Tag>}
                  </span>
                </Tooltip>
              ),
            },
            {
              title: "区块",
              dataIndex: "block_number",
              width: 110,
              render: (v: number | null | undefined) =>
                v ? <Tag color="blue">{v}</Tag> : <span style={{ color: "#888" }}>—</span>,
            },
            {
              title: "Tx",
              dataIndex: "tx_hash",
              width: 200,
              render: (v: string | null | undefined) =>
                v ? (
                  <a
                    href={`https://bscscan.com/tx/${v}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ fontFamily: "monospace" }}
                  >
                    {`${v.slice(0, 10)}…${v.slice(-6)}`}
                  </a>
                ) : (
                  <span style={{ color: "#888" }}>—</span>
                ),
            },
            {
              title: "来源",
              dataIndex: "updated_by",
              width: 240,
              render: (v: string) => (
                <Tag color={v.startsWith("chain-event:") ? "green" : "default"}>{v}</Tag>
              ),
            },
          ]}
        />
      </Card>
    </Space>
  );
}

function DirectionTag({ row }: { row: DecoratedRow }) {
  switch (row.direction) {
    case "add":
      return <Tag color="cyan">新增</Tag>;
    case "remove":
      return <Tag color="red">移除</Tag>;
    case "up":
      return (
        <Tag color="green" icon={<RiseOutlined />}>
          权重↑
        </Tag>
      );
    case "down":
      return (
        <Tag color="orange" icon={<FallOutlined />}>
          权重↓
        </Tag>
      );
    case "same":
    default:
      return (
        <Tag icon={<MinusOutlined />}>
          无变化
        </Tag>
      );
  }
}
