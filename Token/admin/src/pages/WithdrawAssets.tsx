import { useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Form,
  Input,
  Row,
  Space,
  Statistic,
  Tag,
  Typography,
} from "antd";
import { ReloadOutlined, DownloadOutlined } from "@ant-design/icons";
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

const TOKEN_ABI = [
  "function owner() view returns (address)",
  "function vault() view returns (address)",
  "function pair() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function transfer(address,uint256) returns (bool)",
  "function operatorCall(address target, uint256 value, bytes data) returns (bytes)",
];
const VAULT_ABI = [
  "function execute(address target, uint256 value, bytes data) returns (bytes)",
];
const tokenIface = new Interface(TOKEN_ABI);
const vaultIface = new Interface(VAULT_ABI);

interface CoreSnapshot {
  owner: string;
  vault: string;
  pair: string;
  selfTokenBalance: bigint;
  vaultBnbBalance: bigint;
}

export default function WithdrawAssets() {
  const { message } = App.useApp();
  const wallet = useWallet();
  const [snap, setSnap] = useState<CoreSnapshot | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = async () => {
    const settings = loadSettings();
    if (!isTokenConfigured(settings)) {
      message.error("请先填入合约地址");
      return;
    }
    setLoading(true);
    try {
      const [ownerRet, vaultRet, pairRet, selfBalRet] = await Promise.all([
        ethCall(tokenIface.encodeFunctionData("owner", [])),
        ethCall(tokenIface.encodeFunctionData("vault", [])),
        ethCall(tokenIface.encodeFunctionData("pair", [])),
        ethCall(
          tokenIface.encodeFunctionData("balanceOf", [settings.tokenAddress]),
        ),
      ]);
      const [owner] = tokenIface.decodeFunctionResult("owner", ownerRet) as unknown as [string];
      const [vault] = tokenIface.decodeFunctionResult("vault", vaultRet) as unknown as [string];
      const [pair] = tokenIface.decodeFunctionResult("pair", pairRet) as unknown as [string];
      const [selfBal] = tokenIface.decodeFunctionResult("balanceOf", selfBalRet) as unknown as [bigint];
      const vaultBnb = vault !== ZERO ? await getNativeBalance(vault) : 0n;
      setSnap({
        owner: owner.toLowerCase(),
        vault: vault.toLowerCase(),
        pair: pair.toLowerCase(),
        selfTokenBalance: selfBal,
        vaultBnbBalance: vaultBnb,
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

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card
        title="可提取资产概览"
        extra={
          <Button icon={<ReloadOutlined />} loading={loading} onClick={refresh}>
            刷新
          </Button>
        }
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="本页用于将合约或回购金库中暂存的资产提取到指定地址"
          description="所有提取动作均通过合约的 operatorCall 接口签发交易；权限校验完全交由链上合约本身处理（仅运营账户可发起，转移钱包将自动失败），前端不再阻挡。当前钱包若不具备权限，钱包或合约会直接拒绝交易。"
        />
        {snap ? (
          <Row gutter={[16, 16]}>
            <Col xs={24} md={8}>
              <Statistic
                title="合约自持 USCAME"
                value={formatBnb(snap.selfTokenBalance, 4)}
              />
              <div style={{ color: "rgba(255,255,255,0.45)", fontSize: 12, marginTop: 4 }}>
                即买卖税与通缩沉淀的代币
              </div>
            </Col>
            <Col xs={24} md={8}>
              <Statistic
                title="回购金库 BNB 余额"
                value={formatBnb(snap.vaultBnbBalance, 6)}
              />
              <div style={{ color: "rgba(255,255,255,0.45)", fontSize: 12, marginTop: 4 }}>
                <AddressTag value={snap.vault} />
              </div>
            </Col>
            <Col xs={24} md={8}>
              <Statistic
                title="LP 代币地址（PancakeSwap Pair）"
                valueRender={() =>
                  snap.pair === ZERO ? (
                    <Tag color="default">尚未生成</Tag>
                  ) : (
                    <AddressTag value={snap.pair} full />
                  )
                }
              />
              <div style={{ color: "rgba(255,255,255,0.45)", fontSize: 12, marginTop: 4 }}>
                如合约自身或金库代持有 LP，可在下方第三张卡片填入此地址进行提取
              </div>
            </Col>
          </Row>
        ) : (
          <Alert type="info" message="正在读取链上资产信息…" />
        )}
      </Card>

      <WithdrawSelfToken
        balance={snap?.selfTokenBalance ?? 0n}
        defaultReceiver={snap?.owner ?? wallet.account ?? ""}
        onDone={refresh}
      />

      <WithdrawVaultBnb
        vault={snap?.vault ?? ""}
        balance={snap?.vaultBnbBalance ?? 0n}
        defaultReceiver={snap?.owner ?? wallet.account ?? ""}
        onDone={refresh}
      />

      <WithdrawArbitraryErc20
        defaultReceiver={snap?.owner ?? wallet.account ?? ""}
        defaultPair={snap?.pair ?? ""}
        vault={snap?.vault ?? ""}
        onDone={refresh}
      />
    </Space>
  );
}

function WithdrawSelfToken({
  balance,
  defaultReceiver,
  onDone,
}: {
  balance: bigint;
  defaultReceiver: string;
  onDone: () => Promise<void>;
}) {
  const { message, modal } = App.useApp();
  const wallet = useWallet();
  const [receiver, setReceiver] = useState("");
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (defaultReceiver && !receiver) setReceiver(defaultReceiver);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultReceiver]);

  const submit = () => {
    if (!/^0x[a-fA-F0-9]{40}$/.test(receiver)) {
      message.error("接收地址格式不正确");
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
    if (wei > balance) {
      message.error("数量超过合约自持余额");
      return;
    }
    modal.confirm({
      title: "确认提取合约自持 USCAME？",
      content: (
        <div>
          <div>接收地址：{receiver}</div>
          <div>提取数量：{formatBnb(wei, 6)} USCAME</div>
        </div>
      ),
      okText: "签名并上链",
      onOk: async () => {
        if (!wallet.account) {
          message.error("请先连接钱包");
          return;
        }
        setSubmitting(true);
        try {
          const settings = loadSettings();
          // Token from address(this) is feeExempt → no tax applied.
          const inner = tokenIface.encodeFunctionData("transfer", [receiver, wei]);
          const calldata = tokenIface.encodeFunctionData("operatorCall", [
            settings.tokenAddress,
            0n,
            inner,
          ]);
          const tx = await sendTokenTransaction(calldata, wallet.account);
          message.success(`交易已提交：${tx}`);
          await onDone();
        } catch (error) {
          message.error((error as Error).message);
        } finally {
          setSubmitting(false);
        }
      },
    });
  };

  const setMax = () => setAmount(formatBnb(balance, 18));

  return (
    <Card title="提取合约自持的 USCAME 代币">
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        合约自身地址（LP 建设者分红池）持有的 USCAME 由买卖税与通缩沉淀产生。本操作会从合约转出 USCAME 到指定地址，因合约自身已被设为免税，转账不会再次扣税。
      </Typography.Paragraph>
      <Form layout="vertical">
        <Row gutter={16}>
          <Col xs={24} md={14}>
            <Form.Item label="接收地址">
              <Input
                value={receiver}
                onChange={(e) => setReceiver(e.target.value.trim())}
                placeholder="默认填入合约管理员地址"
              />
            </Form.Item>
          </Col>
          <Col xs={24} md={10}>
            <Form.Item label="提取数量（USCAME）" extra={`合约自持余额：${formatBnb(balance, 6)}`}>
              <Input
                value={amount}
                onChange={(e) => setAmount(e.target.value.trim())}
                placeholder="例如：1000"
                addonAfter={
                  <a onClick={setMax} style={{ color: "#73d13d" }}>
                    全部
                  </a>
                }
              />
            </Form.Item>
          </Col>
        </Row>
        <Button type="primary" icon={<DownloadOutlined />} loading={submitting} onClick={submit}>
          发起提取
        </Button>
      </Form>
    </Card>
  );
}

function WithdrawVaultBnb({
  vault,
  balance,
  defaultReceiver,
  onDone,
}: {
  vault: string;
  balance: bigint;
  defaultReceiver: string;
  onDone: () => Promise<void>;
}) {
  const { message, modal } = App.useApp();
  const wallet = useWallet();
  const [receiver, setReceiver] = useState("");
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (defaultReceiver && !receiver) setReceiver(defaultReceiver);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultReceiver]);

  const submit = () => {
    if (!vault || vault === ZERO) {
      message.error("尚未读取到回购金库地址");
      return;
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(receiver)) {
      message.error("接收地址格式不正确");
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
      message.error("请输入大于 0 的金额");
      return;
    }
    if (wei > balance) {
      message.error("金额超过金库余额");
      return;
    }
    modal.confirm({
      title: "确认从回购金库提取 BNB？",
      content: (
        <div>
          <div>金库地址：{vault}</div>
          <div>接收地址：{receiver}</div>
          <div>提取金额：{formatBnb(wei, 6)} BNB</div>
        </div>
      ),
      okText: "签名并上链",
      onOk: async () => {
        if (!wallet.account) {
          message.error("请先连接钱包");
          return;
        }
        setSubmitting(true);
        try {
          // Vault.execute can only be called by the token contract, so wrap
          // via Token.operatorCall(vault, 0, vault.execute(receiver, wei, 0x))
          const inner = vaultIface.encodeFunctionData("execute", [receiver, wei, "0x"]);
          const calldata = tokenIface.encodeFunctionData("operatorCall", [vault, 0n, inner]);
          const tx = await sendTokenTransaction(calldata, wallet.account);
          message.success(`交易已提交：${tx}`);
          await onDone();
        } catch (error) {
          message.error((error as Error).message);
        } finally {
          setSubmitting(false);
        }
      },
    });
  };

  const setMax = () => setAmount(formatBnb(balance, 18));

  return (
    <Card title="提取回购金库（BuybackVault）持有的 BNB">
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        回购金库由合约部署时创建，持有用于自动回购的 BNB。本操作会经由合约的 <code>operatorCall</code> 调用金库的 <code>execute</code>，将 BNB 转给指定地址。
      </Typography.Paragraph>
      <Form layout="vertical">
        <Row gutter={16}>
          <Col xs={24} md={14}>
            <Form.Item label="接收地址">
              <Input
                value={receiver}
                onChange={(e) => setReceiver(e.target.value.trim())}
                placeholder="默认填入合约管理员地址"
              />
            </Form.Item>
          </Col>
          <Col xs={24} md={10}>
            <Form.Item label="提取金额（BNB）" extra={`金库余额：${formatBnb(balance, 6)} BNB`}>
              <Input
                value={amount}
                onChange={(e) => setAmount(e.target.value.trim())}
                placeholder="例如：0.5"
                addonAfter={
                  <a onClick={setMax} style={{ color: "#73d13d" }}>
                    全部
                  </a>
                }
              />
            </Form.Item>
          </Col>
        </Row>
        <Button type="primary" icon={<DownloadOutlined />} loading={submitting} onClick={submit}>
          发起提取
        </Button>
      </Form>
    </Card>
  );
}

function WithdrawArbitraryErc20({
  defaultReceiver,
  defaultPair,
  vault,
  onDone,
}: {
  defaultReceiver: string;
  defaultPair: string;
  vault: string;
  onDone: () => Promise<void>;
}) {
  const { message, modal } = App.useApp();
  const wallet = useWallet();
  const [tokenAddr, setTokenAddr] = useState("");
  const [holder, setHolder] = useState<"contract" | "vault">("contract");
  const [receiver, setReceiver] = useState("");
  const [amount, setAmount] = useState("");
  const [balance, setBalance] = useState<bigint>(0n);
  const [symbol, setSymbol] = useState("");
  const [reading, setReading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (defaultReceiver && !receiver) setReceiver(defaultReceiver);
    if (defaultPair && !tokenAddr && defaultPair !== ZERO) setTokenAddr(defaultPair);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultReceiver, defaultPair]);

  const readBalance = async () => {
    if (!/^0x[a-fA-F0-9]{40}$/.test(tokenAddr)) {
      message.error("请填写合法的代币合约地址");
      return;
    }
    const settings = loadSettings();
    const target = holder === "contract" ? settings.tokenAddress : vault;
    if (!target || target === ZERO) {
      message.error("尚未读取到合约/金库地址，请先返回上方刷新");
      return;
    }
    setReading(true);
    try {
      const balRet = await ethCallTo(
        tokenAddr,
        tokenIface.encodeFunctionData("balanceOf", [target]),
      );
      const [bal] = tokenIface.decodeFunctionResult("balanceOf", balRet) as unknown as [bigint];
      setBalance(bal);
      try {
        const symRet = await ethCallTo(
          tokenAddr,
          tokenIface.encodeFunctionData("symbol", []),
        );
        const [sym] = tokenIface.decodeFunctionResult("symbol", symRet) as unknown as [string];
        setSymbol(sym);
      } catch {
        setSymbol("");
      }
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setReading(false);
    }
  };

  const submit = () => {
    if (!/^0x[a-fA-F0-9]{40}$/.test(tokenAddr)) {
      message.error("代币合约地址格式不正确");
      return;
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(receiver)) {
      message.error("接收地址格式不正确");
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
    if (balance > 0n && wei > balance) {
      message.error("数量超过持仓余额");
      return;
    }
    modal.confirm({
      title: "确认提取该代币？",
      content: (
        <div style={{ wordBreak: "break-all" }}>
          <div>代币：{tokenAddr}</div>
          <div>持有方：{holder === "contract" ? "USCAME 合约自身" : "回购金库（Vault）"}</div>
          <div>接收地址：{receiver}</div>
          <div>数量：{formatBnb(wei, 6)} {symbol || ""}</div>
        </div>
      ),
      okText: "签名并上链",
      onOk: async () => {
        if (!wallet.account) {
          message.error("请先连接钱包");
          return;
        }
        setSubmitting(true);
        try {
          const innerTransfer = tokenIface.encodeFunctionData("transfer", [receiver, wei]);
          let calldata: string;
          if (holder === "contract") {
            calldata = tokenIface.encodeFunctionData("operatorCall", [
              tokenAddr,
              0n,
              innerTransfer,
            ]);
          } else {
            // 通过 operatorCall → vault.execute(tokenAddr, 0, transfer)
            const vaultInner = vaultIface.encodeFunctionData("execute", [
              tokenAddr,
              0n,
              innerTransfer,
            ]);
            calldata = tokenIface.encodeFunctionData("operatorCall", [vault, 0n, vaultInner]);
          }
          const tx = await sendTokenTransaction(calldata, wallet.account);
          message.success(`交易已提交：${tx}`);
          await onDone();
        } catch (error) {
          message.error((error as Error).message);
        } finally {
          setSubmitting(false);
        }
      },
    });
  };

  return (
    <Card title="提取合约 / 金库持有的其它代币（含 PancakeSwap LP）">
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        若合约自身或回购金库代为持有了其它 ERC20 代币（例如 PancakeSwap 的 LP 代币），可在此输入对应的代币合约地址，将余额转出到指定地址。请注意：本项目首次建仓时 LP 代币是直接发放给当时的合约管理员的，通常不会在合约或金库中沉淀。
      </Typography.Paragraph>
      <Form layout="vertical">
        <Row gutter={16}>
          <Col xs={24} md={14}>
            <Form.Item label="代币合约地址" extra="默认填入 PancakeSwap Pair 地址，可改为任意 ERC20">
              <Input
                value={tokenAddr}
                onChange={(e) => {
                  setTokenAddr(e.target.value.trim());
                  setBalance(0n);
                  setSymbol("");
                }}
                placeholder="0x..."
              />
            </Form.Item>
          </Col>
          <Col xs={24} md={10}>
            <Form.Item label="持有方">
              <Space>
                <Button
                  type={holder === "contract" ? "primary" : "default"}
                  onClick={() => {
                    setHolder("contract");
                    setBalance(0n);
                  }}
                >
                  合约自身
                </Button>
                <Button
                  type={holder === "vault" ? "primary" : "default"}
                  onClick={() => {
                    setHolder("vault");
                    setBalance(0n);
                  }}
                >
                  回购金库
                </Button>
                <Button icon={<ReloadOutlined />} loading={reading} onClick={readBalance}>
                  查询余额
                </Button>
              </Space>
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col xs={24} md={14}>
            <Form.Item label="接收地址">
              <Input
                value={receiver}
                onChange={(e) => setReceiver(e.target.value.trim())}
                placeholder="默认填入合约管理员地址"
              />
            </Form.Item>
          </Col>
          <Col xs={24} md={10}>
            <Form.Item
              label="提取数量"
              extra={
                balance > 0n
                  ? `当前余额：${formatBnb(balance, 8)} ${symbol || ""}`
                  : "点击「查询余额」读取当前持仓"
              }
            >
              <Input
                value={amount}
                onChange={(e) => setAmount(e.target.value.trim())}
                placeholder="按代币精度填写（默认 18 位）"
                addonAfter={
                  <a onClick={() => setAmount(formatBnb(balance, 18))} style={{ color: "#73d13d" }}>
                    全部
                  </a>
                }
              />
            </Form.Item>
          </Col>
        </Row>
        <Button type="primary" icon={<DownloadOutlined />} loading={submitting} onClick={submit}>
          发起提取
        </Button>
      </Form>
    </Card>
  );
}
