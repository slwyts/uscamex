import { useState } from "react";
import { Card, Space, Input, Button, Descriptions, Tag, App } from "antd";
import { SearchOutlined, UserOutlined } from "@ant-design/icons";
import { useMutation } from "@tanstack/react-query";
import { api, apiErrorMessage, type UserDetailResponse } from "../utils/api";
import OwnerGate from "../components/OwnerGate";
import AddressTag from "../components/AddressTag";
import { UserTable } from "./QueryTeam";
import { formatBnb } from "../utils/bnb";

export default function QueryUser() {
  return (
    <OwnerGate>
      <UserExplorer />
    </OwnerGate>
  );
}

function UserExplorer() {
  const { message } = App.useApp();
  const [address, setAddress] = useState("");
  const [data, setData] = useState<UserDetailResponse | null>(null);
  const mutation = useMutation({
    mutationFn: async () =>
      (await api().get<UserDetailResponse>("/api/admin/user", { params: { address } })).data,
    onSuccess: (value) => setData(value),
    onError: (error) => message.error(apiErrorMessage(error)),
  });

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card title={<Space><UserOutlined /> 用户详情</Space>}>
        <Space>
          <Input
            placeholder="0x..."
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            style={{ width: 380 }}
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
        <Card title="账户概况">
          <Descriptions bordered column={{ xs: 1, sm: 2, md: 3 }} size="small">
            <Descriptions.Item label="地址" span={3}>
              <AddressTag value={data.summary.address} full />
            </Descriptions.Item>
            <Descriptions.Item label="推荐人">
              {data.referrer_summary ? (
                <AddressTag value={data.referrer_summary.address} />
              ) : (
                <Tag>无 / 根</Tag>
              )}
            </Descriptions.Item>
            <Descriptions.Item label="直推数量">{data.summary.direct_count}</Descriptions.Item>
            <Descriptions.Item label="持仓 ID">{data.summary.position_id}</Descriptions.Item>
            <Descriptions.Item label="本金 BNB">
              {formatBnb(data.summary.principal_bnb, 6)}
            </Descriptions.Item>
            <Descriptions.Item label="静态产出 BNB">
              {formatBnb(data.summary.static_paid_bnb, 6)}
            </Descriptions.Item>
            <Descriptions.Item label="动态产出 BNB">
              {formatBnb(data.summary.dynamic_paid_bnb, 6)}
            </Descriptions.Item>
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
            <Descriptions.Item label="状态">
              <Space>
                {data.summary.active && <Tag color="green">活跃</Tag>}
                {data.summary.exited && <Tag color="red">已退场</Tag>}
                {!data.summary.active && !data.summary.exited && <Tag>未激活</Tag>}
              </Space>
            </Descriptions.Item>
          </Descriptions>
        </Card>
      )}
      {data && (
        <Card title={`直推用户 (${data.direct_members.length})`}>
          <UserTable items={data.direct_members} />
        </Card>
      )}
    </Space>
  );
}
