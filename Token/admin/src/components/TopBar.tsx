import { Space, Button, Tag, Drawer, Form, Input, InputNumber, App } from "antd";
import { useEffect, useState } from "react";
import { SettingOutlined, LinkOutlined, SafetyOutlined } from "@ant-design/icons";
import { useWallet } from "../hooks/useWallet";
import {
  SETTINGS_CHANGED_EVENT,
  loadSettings,
  saveSettings,
  type OperatorSettings,
} from "../utils/settings";
import { shortAddress } from "../utils/address";

export default function TopBar() {
  const { message } = App.useApp();
  const wallet = useWallet();
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<OperatorSettings>(() => loadSettings());
  const [form] = Form.useForm<OperatorSettings>();

  useEffect(() => {
    const refresh = () => setSettings(loadSettings());
    window.addEventListener(SETTINGS_CHANGED_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(SETTINGS_CHANGED_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  const handleConnect = async () => {
    try {
      await wallet.connect();
    } catch (error) {
      message.error((error as Error).message);
    }
  };
  const handleAuthorize = async () => {
    try {
      await wallet.authorize();
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  const onSave = (values: OperatorSettings) => {
    saveSettings(values);
    setSettings(values);
    message.success("已保存连接信息，请重新签名授权");
    wallet.disconnect();
    setOpen(false);
  };

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", height: "100%" }}>
      <Space size={12} wrap>
        <Tag color={settings.tokenAddress ? "gold" : "default"} icon={<LinkOutlined />}>
          {settings.tokenAddress ? `Token ${shortAddress(settings.tokenAddress)}` : "未配置 Token"}
        </Tag>
        <Tag color="blue">Chain {settings.chainId}</Tag>
        <Tag color={wallet.account ? "green" : "default"}>
          {wallet.account ? `钱包 ${shortAddress(wallet.account)}` : "未连接钱包"}
        </Tag>
        <Tag color={wallet.authorized ? "magenta" : "default"} icon={<SafetyOutlined />}>
          {wallet.authorized ? "Owner 已授权" : "未授权后端"}
        </Tag>
      </Space>
      <Space>
        {!wallet.account && (
          <Button type="primary" onClick={handleConnect} loading={wallet.connecting}>
            连接钱包
          </Button>
        )}
        {wallet.account && !wallet.authorized && (
          <Button type="primary" onClick={handleAuthorize}>
            签名授权后端
          </Button>
        )}
        {wallet.account && (
          <Button onClick={() => wallet.disconnect()}>断开</Button>
        )}
        <Button icon={<SettingOutlined />} onClick={() => { form.setFieldsValue(loadSettings()); setOpen(true); }}>
          连接设置
        </Button>
      </Space>
      <Drawer
        title="连接设置"
        open={open}
        onClose={() => setOpen(false)}
        width={420}
      >
        <Form<OperatorSettings>
          form={form}
          layout="vertical"
          initialValues={settings}
          onFinish={onSave}
        >
          <Form.Item label="后端 API 基础地址（可空，留空走同源 / 同站点 /api）" name="apiBase">
            <Input placeholder="例：http://127.0.0.1:8787 或留空" />
          </Form.Item>
          <Form.Item
            label="只读 RPC URL"
            name="rpcUrl"
            rules={[{ required: true, message: "请输入 RPC URL" }]}
          >
            <Input placeholder="例：https://bsc-dataseed.binance.org" />
          </Form.Item>
          <Form.Item
            label="链 ID"
            name="chainId"
            rules={[{ required: true, message: "请输入 chainId" }]}
          >
            <InputNumber min={1} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            label="USCAME 合约地址"
            name="tokenAddress"
            rules={[
              { required: true, message: "请输入合约地址" },
              { pattern: /^0x[0-9a-fA-F]{40}$/, message: "地址格式错误" },
            ]}
          >
            <Input placeholder="0x..." />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>
            保存
          </Button>
        </Form>
      </Drawer>
    </div>
  );
}
