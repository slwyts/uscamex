import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatEther,
  http,
  parseEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const envText = fs.readFileSync(path.join(root, "Token/.env.key"), "utf8");
const pkey = envText.match(/^PKEY=(.+)$/m)?.[1]?.trim();
if (!pkey) throw new Error("PKEY missing");

const artifact = JSON.parse(
  fs.readFileSync(path.join(root, "Token/out/USCAME.sol/USCAME.json"), "utf8"),
);

const RPC_URL = process.env.POLYGON_RPC_URL ?? "https://polygon-bor-rpc.publicnode.com";
const ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const FINAL_OWNER = "0x2872f69D89555B5a3CaD19a8194f7997135808d8";
const NODE_A = "0x676a05c975f447ea13bf09219a1c3acf81031fec";
const NODE_B = "0x98c2e0ecdfa961f8b36144c743fea3951dad0309";
const INITIAL_LP_POL = parseEther("3");
const OWNER_RESERVE = parseEther("10000000");

const account = privateKeyToAccount(pkey.startsWith("0x") ? pkey : `0x${pkey}`);
const publicClient = createPublicClient({ chain: polygon, transport: http(RPC_URL) });
const wallet = createWalletClient({ account, chain: polygon, transport: http(RPC_URL) });

async function wait(hash, label) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== "success") throw new Error(`${label} failed: ${hash}`);
  console.log(`${label}: ${hash} block=${receipt.blockNumber}`);
  return receipt;
}

async function main() {
  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`deployer=${account.address} balance=${formatEther(balance)} POL`);

  const deployHash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: [ROUTER, account.address, account.address],
  });
  const deployReceipt = await wait(deployHash, "deploy");
  const token = deployReceipt.contractAddress;
  if (!token) throw new Error("missing contractAddress");

  const reserveTransfer = encodeFunctionData({
    abi: artifact.abi,
    functionName: "transfer",
    args: [FINAL_OWNER, OWNER_RESERVE],
  });
  await wait(
    await wallet.writeContract({
      address: token,
      abi: artifact.abi,
      functionName: "operatorCall",
      args: [token, 0n, reserveTransfer],
    }),
    "reserve-owner-tokens",
  );

  await wait(await wallet.sendTransaction({ to: token, value: INITIAL_LP_POL }), "fund-initial-lp");
  await wait(
    await wallet.writeContract({ address: token, abi: artifact.abi, functionName: "initializeLP" }),
    "initialize-lp",
  );

  await wait(
    await wallet.writeContract({ address: token, abi: artifact.abi, functionName: "setNode", args: [NODE_A, 1] }),
    "set-node-a",
  );
  await wait(
    await wallet.writeContract({ address: token, abi: artifact.abi, functionName: "setNode", args: [NODE_B, 2] }),
    "set-node-b",
  );

  const teamRewardBps = [1000, 900, 800, 700, 600, 500, 500, 500, 500, 500];
  const config = [
    account.address,
    300,
    1000,
    parseEther("0.1"),
    parseEther("5"),
    false,
    6000,
    1000,
    1000,
    1000,
    1000,
    1000,
    80,
    4,
    30000,
    teamRewardBps,
    true,
    10,
    200,
    false,
    parseEther("0.1"),
    100,
    200,
    100,
    100,
    800,
    parseEther("11"),
  ];
  await wait(
    await wallet.writeContract({ address: token, abi: artifact.abi, functionName: "setProtocolConfig", args: [config] }),
    "set-protocol-config",
  );

  await wait(
    await wallet.writeContract({ address: token, abi: artifact.abi, functionName: "transferOwnership", args: [FINAL_OWNER] }),
    "transfer-owner",
  );

  const [owner, pair, vault, chainConfig] = await Promise.all([
    publicClient.readContract({ address: token, abi: artifact.abi, functionName: "owner" }),
    publicClient.readContract({ address: token, abi: artifact.abi, functionName: "pair" }),
    publicClient.readContract({ address: token, abi: artifact.abi, functionName: "vault" }),
    publicClient.readContract({ address: token, abi: artifact.abi, functionName: "getProtocolConfig" }),
  ]);

  console.log(JSON.stringify({
    token,
    deployTx: deployHash,
    deployBlock: Number(deployReceipt.blockNumber),
    owner,
    operator: chainConfig.operator,
    pair,
    vault,
    initialLpPol: INITIAL_LP_POL.toString(),
    ownerReserveTokens: OWNER_RESERVE.toString(),
    buybackEnabled: chainConfig.buybackEnabled,
    sellTaxBuilderBps: chainConfig.sellTaxBuilderBps,
    sellTaxOwnerBps: chainConfig.sellTaxOwnerBps,
    sellTaxVaultBps: chainConfig.sellTaxVaultBps,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
