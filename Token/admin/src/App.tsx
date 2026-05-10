import { Layout, Menu } from "antd";
import { useEffect } from "react";
import { Routes, Route, Link, useLocation, Navigate } from "react-router-dom";
import {
  DashboardOutlined,
  BranchesOutlined,
  UserOutlined,
  TeamOutlined,
  NodeIndexOutlined,
  HistoryOutlined,
  WalletOutlined,
  SettingOutlined,
  RocketOutlined,
  GoldOutlined,
  AuditOutlined,
} from "@ant-design/icons";
import TopBar from "./components/TopBar";
import { bootstrapSettingsFromBackend } from "./utils/settings";
import QueryOverview from "./pages/QueryOverview";
import QueryTeam from "./pages/QueryTeam";
import QueryUser from "./pages/QueryUser";
import QueryUsers from "./pages/QueryUsers";
import QueryNodes from "./pages/QueryNodes";
import QueryPositions from "./pages/QueryPositions";
import QueryJournal from "./pages/QueryJournal";
import QueryConfigHistory from "./pages/QueryConfigHistory";
import QueryNodeHistory from "./pages/QueryNodeHistory";
import ConfigParams from "./pages/ConfigParams";
import ConfigNodes from "./pages/ConfigNodes";
import ConfigLp from "./pages/ConfigLp";
import ConfigOperator from "./pages/ConfigOperator";

const { Sider, Content, Header } = Layout;

const QUERY_ITEMS = [
  { key: "/query/overview", icon: <DashboardOutlined />, label: <Link to="/query/overview">总览</Link> },
  { key: "/query/team", icon: <BranchesOutlined />, label: <Link to="/query/team">团队结构</Link> },
  { key: "/query/user", icon: <UserOutlined />, label: <Link to="/query/user">用户详情</Link> },
  { key: "/query/users", icon: <TeamOutlined />, label: <Link to="/query/users">用户列表</Link> },
  { key: "/query/nodes", icon: <NodeIndexOutlined />, label: <Link to="/query/nodes">节点收益</Link> },
  { key: "/query/positions", icon: <GoldOutlined />, label: <Link to="/query/positions">持仓清单</Link> },
  { key: "/query/journal", icon: <HistoryOutlined />, label: <Link to="/query/journal">执行流水</Link> },
  {
    key: "/query/config-history",
    icon: <AuditOutlined />,
    label: <Link to="/query/config-history">配置历史</Link>,
  },
  {
    key: "/query/node-history",
    icon: <HistoryOutlined />,
    label: <Link to="/query/node-history">节点历史</Link>,
  },
];

const CONFIG_ITEMS = [
  { key: "/config/params", icon: <SettingOutlined />, label: <Link to="/config/params">业务参数</Link> },
  { key: "/config/nodes", icon: <NodeIndexOutlined />, label: <Link to="/config/nodes">节点管理</Link> },
  { key: "/config/lp", icon: <RocketOutlined />, label: <Link to="/config/lp">LP 初始化</Link> },
  { key: "/config/operator", icon: <WalletOutlined />, label: <Link to="/config/operator">Operator/Owner 操作</Link> },
];

export default function App() {
  const location = useLocation();
  const selected = [location.pathname];
  const groupKey = location.pathname.startsWith("/config") ? "g-config" : "g-query";

  useEffect(() => {
    bootstrapSettingsFromBackend().catch(() => {
      // backend may be temporarily unreachable; settings remain as last saved
    });
  }, []);

  return (
    <Layout className="app-shell">
      <Sider width={232} style={{ background: "#11131a", borderRight: "1px solid #1f2230" }}>
        <div className="brand-row">
          <span className="brand-dot">U</span>
          <span>USCAMEX Admin</span>
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={selected}
          defaultOpenKeys={[groupKey]}
          style={{ background: "transparent", borderInlineEnd: "none" }}
          items={[
            {
              key: "g-query",
              type: "group",
              label: (
                <span style={{ color: "rgba(255,255,255,0.45)", fontSize: 12 }}>
                  数据查询
                </span>
              ),
              children: QUERY_ITEMS,
            },
            {
              key: "g-config",
              type: "group",
              label: (
                <span style={{ color: "rgba(255,255,255,0.45)", fontSize: 12 }}>
                  配置修改
                </span>
              ),
              children: CONFIG_ITEMS,
            },
          ]}
        />
        <div style={{ padding: "12px 18px", color: "rgba(255,255,255,0.35)", fontSize: 11 }}>
          <WalletOutlined /> 链上为准 · 链下索引仅辅助查询
        </div>
      </Sider>
      <Layout>
        <Header
          style={{
            background: "rgba(17, 19, 26, 0.85)",
            borderBottom: "1px solid #1f2230",
            padding: "0 24px",
            backdropFilter: "blur(8px)",
          }}
        >
          <TopBar />
        </Header>
        <Content style={{ padding: 24, overflow: "auto" }}>
          <Routes>
            <Route path="/" element={<Navigate to="/query/overview" replace />} />
            <Route path="/query" element={<Navigate to="/query/overview" replace />} />
            <Route path="/query/overview" element={<QueryOverview />} />
            <Route path="/query/team" element={<QueryTeam />} />
            <Route path="/query/user" element={<QueryUser />} />
            <Route path="/query/users" element={<QueryUsers />} />
            <Route path="/query/nodes" element={<QueryNodes />} />
            <Route path="/query/positions" element={<QueryPositions />} />
            <Route path="/query/journal" element={<QueryJournal />} />
            <Route path="/query/config-history" element={<QueryConfigHistory />} />
            <Route path="/query/node-history" element={<QueryNodeHistory />} />
            <Route path="/config" element={<Navigate to="/config/params" replace />} />
            <Route path="/config/params" element={<ConfigParams />} />
            <Route path="/config/nodes" element={<ConfigNodes />} />
            <Route path="/config/lp" element={<ConfigLp />} />
            <Route path="/config/operator" element={<ConfigOperator />} />
            <Route path="*" element={<Navigate to="/query/overview" replace />} />
          </Routes>
        </Content>
      </Layout>
    </Layout>
  );
}
