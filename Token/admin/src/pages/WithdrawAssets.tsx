import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Input,
  Row,
  Space,
  Statistic,
  Tag,
  Typography,
} from "antd";
import {
  BankOutlined,
  DownloadOutlined,
  ReloadOutlined,
  WalletOutlined,
} from "@ant-design/icons";
import { Interface } from "ethers";
import { useWallet } from "../hooks/useWallet";
import {
  ethCall,
  ethCallTo,
  getNativeBalance,
  sendTokenTransaction,
} from "../utils/chain";
import { isTokenConfigured, loadSettings } from "../utils/settings";
import { formatBnb, parseBnb } from "../utils/bnb";
import AddressTag from "../components/AddressTag";

const ZERO = "0x0000000000000000000000000000000000000000";

type SourceKey = "token" | "vault";
type AssetKey = "bnb" | "uscamex" | "lpToken";

const TOKEN_ABI = [
  "function owner() view returns (address)",
  "function vault() view returns (address)",
  "function pair() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function operatorCall(address target, uint256 value, bytes data) returns (bytes)",
];
const VAULT_ABI = [
  "function execute(address target, uint256 value, bytes data) returns (bytes)",
];
const tokenIface = new Interface(TOKEN_ABI);
const erc20Iface = new Interface([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
]);
const vaultIface = new Interface(VAULT_ABI);

interface SourceBalances {
  bnb: bigint;
  uscamex: bigint;
  lpToken: bigint;
}

interface CoreSnapshot {
  owner: string;
  tokenAddress: string;
  vault: string;
  pair: string;
  balances: Record<SourceKey, SourceBalances>;
}

const EMPTY_BALANCES: SourceBalances = {
  bnb: 0n,
  uscamex: 0n,
  lpToken: 0n,
};

const ASSET_META: Array<{
  key: AssetKey;
  title: string;
  unit: string;
  precision: number;
}> = [
  { key: "bnb", title: "BNB", unit: "BNB", precision: 6 },
  { key: "uscamex", title: "USCAME", unit: "USCAME", precision: 4 },
  { key: "lpToken", title: "LP Token", unit: "LP", precision: 6 },
];

export default function WithdrawAssets() {
  const { message, modal } = App.useApp();
  const wallet = useWallet();
  const [snap, setSnap] = useState<CoreSnapshot | null>(null);
  const [source, setSource] = useState<SourceKey>("token");
  const [asset, setAsset] = useState<AssetKey>("uscamex");
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const refresh = async () => {
    const settings = loadSettings();
    if (!isTokenConfigured(settings)) {
      message.error("请先填入合约地址");
      return;
    }
    setLoading(true);
    try {
      const tokenAddress = settings.tokenAddress.toLowerCase();
      const [ownerRet, vaultRet, pairRet] = await Promise.all([
        ethCall(tokenIface.encodeFunctionData("owner", [])),
        ethCall(tokenIface.encodeFunctionData("vault", [])),
        ethCall(tokenIface.encodeFunctionData("pair", [])),
      ]);
      const [owner] = tokenIface.decodeFunctionResult("owner", ownerRet) as unknown as [string];
      const [vault] = tokenIface.decodeFunctionResult("vault", vaultRet) as unknown as [string];
      const [pair] = tokenIface.decodeFunctionResult("pair", pairRet) as unknown as [string];
      const vaultAddress = vault.toLowerCase();
      const pairAddress = pair.toLowerCase();

      const [tokenBalances, vaultBalances] = await Promise.all([
        readSourceBalances(tokenAddress, tokenAddress, pairAddress),
        vaultAddress === ZERO
          ? Promise.resolve({ ...EMPTY_BALANCES })
          : readSourceBalances(vaultAddress, tokenAddress, pairAddress),
      ]);

      setSnap({
        owner: owner.toLowerCase(),
        tokenAddress,
        vault: vaultAddress,
        pair: pairAddress,
        balances: {
          token: tokenBalances,
          vault: vaultBalances,
        },
      });
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

  const sourceOptions = useMemo(
    () => [
      {
        key: "token" as SourceKey,
        title: "Token 合约",
        badge: "LP 建设者分红池",
        address: snap?.tokenAddress || "",
      },
      {
        key: "vault" as SourceKey,
        title: "Vault 合约",
        badge: "回购销毁金库",
        address: snap?.vault || "",
      },
    ],
    [snap],
  );

  const currentBalances = snap?.balances[source] ?? EMPTY_BALANCES;
  const selectedBalance = currentBalances[asset];
  const selectedAsset = ASSET_META.find((item) => item.key === asset) ?? ASSET_META[0];
  const sourceAddress = source === "token" ? snap?.tokenAddress : snap?.vault;
  const assetDisabled = asset === "lpToken" && (!snap?.pair || snap.pair === ZERO);
  const canSubmit = Boolean(snap && wallet.account && !assetDisabled && selectedBalance > 0n);

  const setMax = () => setAmount(formatBnb(selectedBalance, 18));

  const submit = () => {
    if (!snap) {
      message.error("尚未读取到链上资产信息");
      return;
    }
    if (!wallet.account) {
      message.error("请先连接钱包");
      return;
    }
    if (source === "vault" && snap.vault === ZERO) {
      message.error("尚未读取到 Vault 地址");
      return;
    }
    if (asset === "lpToken" && snap.pair === ZERO) {
      message.error("尚未生成 LP Token 地址");
      return;
    }
    let wei: bigint;
    try {
      wei = parseBnb(amount);
    } catch (error) {
      message.error((error as Error).message);
      return;
    }
    if (wei <= 0n) {
      message.error("请输入大于 0 的数量");
      return;
    }
    if (wei > selectedBalance) {
      message.error("数量超过当前可提余额");
      return;
    }

    const receiver = wallet.account.toLowerCase();
    modal.confirm({
      title: "确认提取资产？",
      content: (
        <div style={{ wordBreak: "break-all" }}>
          <div>来源：{source === "token" ? "Token 合约" : "Vault 合约"}</div>
          <div>资产：{selectedAsset.title}</div>
          <div>数量：{formatBnb(wei, selectedAsset.precision)} {selectedAsset.unit}</div>
          <div>接收钱包：{receiver}</div>
        </div>
      ),
      okText: "签名并上链",
      onOk: async () => {
        setSubmitting(true);
        try {
          const calldata = buildWithdrawCalldata(snap, source, asset, receiver, wei);
          const tx = await sendTokenTransaction(calldata, wallet.account);
          message.success(`交易已提交：${tx}`);
          setAmount("");
          await refresh();
        } catch (error) {
          message.error((error as Error).message);
        } finally {
          setSubmitting(false);
        }
      },
    });
  };

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card
        title="资产提取"
        extra={
          <Button icon={<ReloadOutlined />} loading={loading} onClick={refresh}>
            刷新
          </Button>
        }
      >
        <Row gutter={[16, 16]}>
          <Col xs={24} md={8}>
            <Statistic
              title="接收钱包"
              valueRender={() =>
                wallet.account ? (
                  <AddressTag value={wallet.account} full />
                ) : (
                  <Button icon={<WalletOutlined />} loading={wallet.connecting} onClick={wallet.connect}>
                    连接钱包
                  </Button>
                )
              }
            />
          </Col>
          <Col xs={24} md={8}>
            <Statistic
              title="Token 合约"
              valueRender={() => <AddressTag value={snap?.tokenAddress} full />}
            />
          </Col>
          <Col xs={24} md={8}>
            <Statistic
              title="Vault 合约"
              valueRender={() => <AddressTag value={snap?.vault} full />}
            />
          </Col>
        </Row>
      </Card>

      <Card title="选择来源地址" className="withdraw-panel">
        <div className="withdraw-choice-grid two">
          {sourceOptions.map((option) => {
            const selected = source === option.key;
            const disabled = option.key === "vault" && (!option.address || option.address === ZERO);
            return (
              <button
                key={option.key}
                type="button"
                className={`withdraw-choice${selected ? " selected" : ""}`}
                disabled={disabled}
                onClick={() => {
                  setSource(option.key);
                  setAmount("");
                }}
              >
                <span className="withdraw-choice-title">
                  <BankOutlined /> {option.title}
                </span>
                <span className="withdraw-choice-meta">{option.badge}</span>
                <span className="withdraw-choice-address">
                  <AddressTag value={option.address} />
                </span>
              </button>
            );
          })}
        </div>
      </Card>

      <Card title="选择资产" className="withdraw-panel">
        {assetDisabled && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message="当前合约尚未读取到 LP Token 地址"
          />
        )}
        <div className="withdraw-choice-grid three">
          {ASSET_META.map((item) => {
            const balance = currentBalances[item.key];
            const selected = asset === item.key;
            const disabled = item.key === "lpToken" && (!snap?.pair || snap.pair === ZERO);
            return (
              <button
                key={item.key}
                type="button"
                className={`withdraw-choice asset${selected ? " selected" : ""}`}
                disabled={disabled}
                onClick={() => {
                  setAsset(item.key);
                  setAmount("");
                }}
              >
                <span className="withdraw-choice-title">{item.title}</span>
                <span className="withdraw-balance">
                  {formatBnb(balance, item.precision)} {item.unit}
                </span>
                {item.key === "lpToken" && snap?.pair && snap.pair !== ZERO && (
                  <span className="withdraw-choice-meta">
                    <AddressTag value={snap.pair} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </Card>

      <Card title="提取数量" className="withdraw-panel">
        <Row gutter={[16, 16]} align="bottom">
          <Col xs={24} lg={10}>
            <Typography.Text type="secondary">来源地址</Typography.Text>
            <div className="withdraw-inline-value">
              <AddressTag value={sourceAddress} full />
              <Tag color={source === "token" ? "gold" : "blue"} className="tag-mini">
                {source === "token" ? "Token" : "Vault"}
              </Tag>
            </div>
          </Col>
          <Col xs={24} lg={8}>
            <Typography.Text type="secondary">可提余额</Typography.Text>
            <div className="withdraw-inline-value strong">
              {formatBnb(selectedBalance, selectedAsset.precision)} {selectedAsset.unit}
            </div>
          </Col>
          <Col xs={24} lg={6}>
            <Typography.Text type="secondary">接收钱包</Typography.Text>
            <div className="withdraw-inline-value">
              <AddressTag value={wallet.account} />
            </div>
          </Col>
          <Col xs={24} lg={18}>
            <Input
              size="large"
              value={amount}
              onChange={(event) => setAmount(event.target.value.trim())}
              placeholder={`输入 ${selectedAsset.title} 数量`}
              addonAfter={
                <Button type="link" size="small" disabled={selectedBalance === 0n} onClick={setMax}>
                  全部
                </Button>
              }
            />
          </Col>
          <Col xs={24} lg={6}>
            <Button
              block
              size="large"
              type="primary"
              icon={<DownloadOutlined />}
              loading={submitting}
              disabled={!canSubmit}
              onClick={submit}
            >
              提取到当前钱包
            </Button>
          </Col>
        </Row>
      </Card>
    </Space>
  );
}

async function readSourceBalances(
  sourceAddress: string,
  tokenAddress: string,
  pairAddress: string,
): Promise<SourceBalances> {
  const [bnb, uscamexRet, lpRet] = await Promise.all([
    getNativeBalance(sourceAddress),
    ethCallTo(tokenAddress, erc20Iface.encodeFunctionData("balanceOf", [sourceAddress])),
    pairAddress === ZERO
      ? Promise.resolve("0x")
      : ethCallTo(pairAddress, erc20Iface.encodeFunctionData("balanceOf", [sourceAddress])),
  ]);
  const [uscamex] = erc20Iface.decodeFunctionResult("balanceOf", uscamexRet) as unknown as [bigint];
  const lpToken =
    pairAddress === ZERO
      ? 0n
      : (erc20Iface.decodeFunctionResult("balanceOf", lpRet) as unknown as [bigint])[0];
  return { bnb, uscamex, lpToken };
}

function buildWithdrawCalldata(
  snap: CoreSnapshot,
  source: SourceKey,
  asset: AssetKey,
  receiver: string,
  amount: bigint,
): string {
  if (source === "token") {
    if (asset === "bnb") {
      return tokenIface.encodeFunctionData("operatorCall", [receiver, amount, "0x"]);
    }
    const assetAddress = resolveAssetAddress(snap, asset);
    const transferData = erc20Iface.encodeFunctionData("transfer", [receiver, amount]);
    return tokenIface.encodeFunctionData("operatorCall", [assetAddress, 0n, transferData]);
  }

  if (!snap.vault || snap.vault === ZERO) throw new Error("尚未读取到 Vault 地址");
  if (asset === "bnb") {
    const vaultData = vaultIface.encodeFunctionData("execute", [receiver, amount, "0x"]);
    return tokenIface.encodeFunctionData("operatorCall", [snap.vault, 0n, vaultData]);
  }
  const assetAddress = resolveAssetAddress(snap, asset);
  const transferData = erc20Iface.encodeFunctionData("transfer", [receiver, amount]);
  const vaultData = vaultIface.encodeFunctionData("execute", [assetAddress, 0n, transferData]);
  return tokenIface.encodeFunctionData("operatorCall", [snap.vault, 0n, vaultData]);
}

function resolveAssetAddress(snap: CoreSnapshot, asset: AssetKey): string {
  if (asset === "uscamex") return snap.tokenAddress;
  if (asset === "lpToken") {
    if (!snap.pair || snap.pair === ZERO) throw new Error("尚未生成 LP Token 地址");
    return snap.pair;
  }
  throw new Error("BNB 没有 ERC20 合约地址");
}