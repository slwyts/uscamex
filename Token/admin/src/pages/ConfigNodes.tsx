import { useEffect, useState } from "react";
import {
  Card,
  Table,
  Button,
  Space,
  Form,
  Input,
  InputNumber,
  Modal,
  App,
  Popconfirm,
  Tag,
  Empty,
} from "antd";
import { PlusOutlined, ReloadOutlined, DeleteOutlined, EditOutlined } from "@ant-design/icons";
import { Interface } from "ethers";
import { useWallet } from "../hooks/useWallet";
import { ethCall, sendTokenTransaction } from "../utils/chain";
import { isTokenConfigured, loadSettings } from "../utils/settings";
import AddressTag from "../components/AddressTag";

const ABI = [
  "function nodeCount() view returns (uint256)",
  "function nodeAt(uint256 index) view returns (address node, uint32 weight)",
  "function setNode(address node, uint32 weight)",
];
const iface = new Interface(ABI);

interface NodeRow {
  address: string;
  weight: number;
}

export default function ConfigNodes() {
  const { message, modal } = App.useApp();
  const wallet = useWallet();
  const [rows, setRows] = useState<NodeRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<NodeRow | null>(null);
  const [form] = Form.useForm<NodeRow>();
  const [submitting, setSubmitting] = useState(false);

  const settings = loadSettings();

  const refresh = async () => {
    if (!isTokenConfigured(settings)) {
      message.error("请先配置合约地址");
      return;
    }
    setLoading(true);
    try {
      const countData = iface.encodeFunctionData("nodeCount", []);
      const countRet = await ethCall(countData);
      const [count] = iface.decodeFunctionResult("nodeCount", countRet) as unknown as [bigint];
      const total = Number(count);
      const items: NodeRow[] = [];
      for (let i = 0; i < total; i += 1) {
        const data = iface.encodeFunctionData("nodeAt", [i]);
        const ret = await ethCall(data);
        const [addr, weight] = iface.decodeFunctionResult("nodeAt", ret) as unknown as [string, bigint];
        items.push({ address: addr.toLowerCase(), weight: Number(weight) });
      }
      setRows(items);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitNode = async (values: NodeRow) => {
    if (!wallet.account) {
      message.error("请连接 Owner 钱包");
      return;
    }
    setSubmitting(true);
    try {
      const data = iface.encodeFunctionData("setNode", [values.address, values.weight]);
      const tx = await sendTokenTransaction(data, wallet.account);
      message.success(`已发送：${tx}`);
      setOpen(false);
      form.resetFields();
      setEditing(null);
      await refresh();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const removeNode = async (row: NodeRow) => {
    if (!wallet.account) {
      message.error("请连接 Owner 钱包");
      return;
    }
    try {
      const data = iface.encodeFunctionData("setNode", [row.address, 0]);
      const tx = await sendTokenTransaction(data, wallet.account);
      message.success(`已发送 (移除)：${tx}`);
      await refresh();
    } catch (error) {
      modal.error({ title: "失败", content: (error as Error).message });
    }
  };

  const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);

  return (
    <Card
      title="节点管理"
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} onClick={refresh} loading={loading}>
            刷新链上
          </Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setEditing(null);
              form.resetFields();
              setOpen(true);
            }}
          >
            添加节点
          </Button>
        </Space>
      }
    >
      <Space style={{ marginBottom: 12 }}>
        <Tag color="gold">节点总数 {rows.length}</Tag>
        <Tag color="purple">权重合计 {totalWeight}</Tag>
      </Space>
      <Table<NodeRow>
        rowKey="address"
        loading={loading}
        dataSource={rows}
        size="small"
        pagination={false}
        locale={{ emptyText: <Empty description="链上暂无节点" /> }}
        columns={[
          { title: "地址", dataIndex: "address", render: (v: string) => <AddressTag value={v} full /> },
          { title: "权重", dataIndex: "weight", width: 120, align: "right" },
          {
            title: "占比",
            width: 120,
            align: "right",
            render: (_, row) =>
              totalWeight > 0 ? `${((row.weight / totalWeight) * 100).toFixed(2)}%` : "-",
          },
          {
            title: "操作",
            width: 200,
            render: (_, row) => (
              <Space>
                <Button
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => {
                    setEditing(row);
                    form.setFieldsValue(row);
                    setOpen(true);
                  }}
                >
                  调整权重
                </Button>
                <Popconfirm
                  title={`确认移除 ${row.address.slice(0, 10)}…？`}
                  onConfirm={() => removeNode(row)}
                  okText="移除"
                  cancelText="取消"
                >
                  <Button size="small" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <Modal
        title={editing ? "调整节点权重" : "添加节点"}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={submitting}
        destroyOnClose
      >
        <Form<NodeRow> form={form} layout="vertical" onFinish={submitNode}>
          <Form.Item
            label="节点地址"
            name="address"
            rules={[
              { required: true, message: "请输入地址" },
              { pattern: /^0x[0-9a-fA-F]{40}$/, message: "地址格式错误" },
            ]}
          >
            <Input placeholder="0x..." disabled={!!editing} />
          </Form.Item>
          <Form.Item
            label="权重 (uint32, 0 表示移除)"
            name="weight"
            rules={[{ required: true, message: "请输入权重" }]}
          >
            <InputNumber min={1} max={4_000_000_000} style={{ width: "100%" }} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
