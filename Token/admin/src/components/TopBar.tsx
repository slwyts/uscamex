import { Space, Button, Tag, Drawer, Form, Input, App } from "antd";
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

  const onSave = (values: Pick<OperatorSettings, "apiBase">) => {
    const merged: OperatorSettings = { ...settings, apiBase: values.apiBase ?? "" };
    saveSettings(merged);
    setSettings(merged);
    message.success("已保存");
    wallet.disconnect();
    setOpen(false);
  };

  const accountMismatchOwner =
    !!wallet.account &&
    !!wallet.owner &&
    wallet.account.toLowerCase() !== wallet.owner.toLowerCase();

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", height: "100%" }}>
      <Space size={12} wrap>
        <Tag color={settings.tokenAddress ? "gold" : "default"} icon={<LinkOutlined />}>
          {settings.tokenAddress ? `合约 ${shortAddress(settings.tokenAddress)}` : "未配置合约地址"}
        </Tag>
        <Tag color="blue">{settings.chainConfig.name}</Tag>
        {wallet.owner && (
          <Tag color="purple">合约管理员 {shortAddress(wallet.owner)}</Tag>
        )}
        <Tag
          color={
            wallet.account
              ? accountMismatchOwner
                ? "red"
                : "green"
              : "default"
          }
        >
          {wallet.account
            ? accountMismatchOwner
              ? `当前钱包 ${shortAddress(wallet.account)}（非管理员）`
              : `当前钱包 ${shortAddress(wallet.account)}`
            : "尚未连接钱包"}
        </Tag>
        <Tag color={wallet.authorized ? "magenta" : "default"} icon={<SafetyOutlined />}>
          {wallet.authorized ? "管理签名已生效" : "管理签名未生效"}
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
            签名以启用管理
          </Button>
        )}
        {wallet.account && (
          <Button onClick={() => wallet.disconnect()}>退出登录</Button>
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
          <Form.Item label="后端 API 地址（留空则使用当前站点 /api）" name="apiBase">
            <Input placeholder="例：http://127.0.0.1:8787，留空表示同站点" />
          </Form.Item>
          <div style={{ marginBottom: 16, padding: "8px 12px", background: "#fafafa", borderRadius: 4, fontSize: 13 }}>
            <div>链：{settings.chainConfig.name}（ID {settings.chainConfig.id}）</div>
            <div>RPC：{settings.chainConfig.rpcUrl}</div>
            <div>代币：{settings.tokenAddress ? shortAddress(settings.tokenAddress) : "未配置"}</div>
            <div style={{ marginTop: 4, color: "#888" }}>以上信息从后端 /api/health 自动同步</div>
          </div>
          <Button type="primary" htmlType="submit" block>
            保存
          </Button>
        </Form>
      </Drawer>
    </div>
  );
}
