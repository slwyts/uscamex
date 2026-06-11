import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseEther,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";

const HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";
const BSC_CHAIN_ID = 56;
const BSC_BLOCK_TIME_SECONDS = 3;
const DEFAULT_BSC_FORK_URL = "https://bsc-rpc.publicnode.com";
const BSC_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN_DIR = join(ROOT, "Token");
const WORKER_DIR = join(TOKEN_DIR, "worker");
const LOCALTEST_DIR = join(TOKEN_DIR, "localtest");
const MANIFEST_PATH = join(LOCALTEST_DIR, "manifest.json");
const WORKER_CONFIG_PATH = join(WORKER_DIR, "wrangler.localtest.generated.jsonc");
const WORKER_DEV_VARS_PATH = join(WORKER_DIR, ".dev.vars.localtest");
const WORKER_LOCAL_DIR = join(WORKER_DIR, ".localtest");
const LOCALTEST_ADMIN_DIST = join(LOCALTEST_DIR, "admin-dist");

loadDotEnv(join(ROOT, ".env"));
loadDotEnv(join(ROOT, ".env.localtest"));
loadDotEnv(join(TOKEN_DIR, ".env"));
loadDotEnv(join(TOKEN_DIR, ".env.localtest"));

const LOCAL_RPC_URL = process.env.LOCALTEST_RPC_URL || "http://127.0.0.1:8545";
const WORKER_PORT = Number(process.env.LOCALTEST_WORKER_PORT || "8787");
const INITIAL_LP_BNB = process.env.LOCALTEST_INITIAL_LP_BNB || "10";
const SEED_USCAMEX = process.env.LOCALTEST_SEED_USCAMEX || "10000";
const LOCALTEST_CRON_INTERVAL_MS = Number(process.env.LOCALTEST_CRON_INTERVAL_MS || "60000");
const forkUrl = process.env.LOCALTEST_FORK_URL || process.env.BSC_RPC_URL || DEFAULT_BSC_FORK_URL;

const bscLocal = {
  id: BSC_CHAIN_ID,
  name: "BSC Local Fork",
  nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
  rpcUrls: { default: { http: [LOCAL_RPC_URL] } },
};

const accounts = Array.from({ length: 20 }, (_, i) => accountAt(i));
const owner = accounts[0];
const operator = accounts[19];
const children = [];
const timers = new Set();

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", () => {
  for (const child of children) child.kill("SIGTERM");
});

await main();

async function main() {
  mkdirSync(LOCALTEST_DIR, { recursive: true });
  await run("forge", ["build"], { cwd: TOKEN_DIR });
  await run("pnpm", ["--dir", "Token/admin", "install"], { cwd: ROOT });
  await run("pnpm", ["--dir", "Token/admin", "build"], { cwd: ROOT });
  prepareLocaltestAdminDist();

  const forkBlock = await resolveForkBlockNumber();
  const anvil = startAnvil(forkBlock);
  children.push(anvil);
  await waitForRpc(LOCAL_RPC_URL);

  const publicClient = createPublicClient({ chain: bscLocal, transport: http(LOCAL_RPC_URL) });
  const walletClient = createWalletClient({ account: owner, chain: bscLocal, transport: http(LOCAL_RPC_URL) });
  const artifact = readArtifact();

  log(`owner #1    ${owner.address}`);
  log(`operator #20 ${operator.address}`);
  log(`deploying USCAMEX to BSC fork via ${LOCAL_RPC_URL}`);

  const deployHash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [BSC_ROUTER, owner.address, operator.address],
  });
  const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
  const tokenAddress = deployReceipt.contractAddress;
  if (!tokenAddress) fail("USCAMEX deploy receipt did not contain a contract address");
  log(`USCAMEX deployed ${tokenAddress} at block ${deployReceipt.blockNumber}`);

  const seedAmount = parseEther(SEED_USCAMEX);
  if (seedAmount > 0n) {
    log(`seeding ${SEED_USCAMEX} USCAMEX to each of the 20 local accounts`);
    const targets = accounts.map(() => tokenAddress);
    const values = accounts.map(() => 0n);
    const datas = accounts.map((account) =>
      encodeFunctionData({
        abi: artifact.abi,
        functionName: "transfer",
        args: [account.address, seedAmount],
      }),
    );
    const seedHash = await walletClient.writeContract({
      address: tokenAddress,
      abi: artifact.abi,
      functionName: "operatorBatchCall",
      args: [targets, values, datas],
    });
    await publicClient.waitForTransactionReceipt({ hash: seedHash });
  }

  log(`funding initial LP with ${INITIAL_LP_BNB} BNB from owner #1`);
  const fundHash = await walletClient.sendTransaction({ to: tokenAddress, value: parseEther(INITIAL_LP_BNB) });
  await publicClient.waitForTransactionReceipt({ hash: fundHash });

  log("initializing LP on forked PancakeSwap V2 router");
  const initHash = await walletClient.writeContract({
    address: tokenAddress,
    abi: artifact.abi,
    functionName: "initializeLP",
  });
  await publicClient.waitForTransactionReceipt({ hash: initHash });

  const [vaultAddress, pairAddress, currentBlock] = await Promise.all([
    publicClient.readContract({ address: tokenAddress, abi: artifact.abi, functionName: "vault" }),
    publicClient.readContract({ address: tokenAddress, abi: artifact.abi, functionName: "pair" }),
    publicClient.getBlockNumber(),
  ]);

  writeLocaltestFiles({
    tokenAddress,
    vaultAddress,
    pairAddress,
    deploymentBlock: deployReceipt.blockNumber,
    currentBlock,
    forkBlock,
  });
  injectAdminLocaltestWallet();
  resetLocalWorkerState();

  await run(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "uscamex_operator_localtest",
      "--local",
      "--config",
      "wrangler.localtest.generated.jsonc",
      "--env-file",
      ".dev.vars.localtest",
      "--persist-to",
      ".localtest/wrangler-state",
    ],
    { cwd: WORKER_DIR, env: { ...process.env, CI: "true" } },
  );

  log(`starting wrangler dev on http://127.0.0.1:${WORKER_PORT}`);
  const wrangler = spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "dev",
      "--config",
      "wrangler.localtest.generated.jsonc",
      "--env-file",
      ".dev.vars.localtest",
      "--local",
      "--test-scheduled",
      "--port",
      String(WORKER_PORT),
      "--persist-to",
      ".localtest/wrangler-state",
      "--show-interactive-dev-session=false",
    ],
    { cwd: WORKER_DIR, env: { ...process.env, NODE_ENV: "production" }, stdio: "inherit" },
  );
  children.push(wrangler);

  const workerUrl = `http://127.0.0.1:${WORKER_PORT}`;
  await waitForHttp(`${workerUrl}/api/health`);
  log(`worker ready: ${workerUrl}/api/health`);
  startLocalCron(workerUrl);
  log("wallet tool: pnpm run localtest:wallet");
  log(`token=${tokenAddress} vault=${vaultAddress} pair=${pairAddress}`);

  await new Promise((resolvePromise) => wrangler.on("exit", resolvePromise));
  shutdown();
}

function startAnvil(forkBlock) {
  const args = [
    "--fork-url",
    forkUrl,
    "--fork-block-number",
    forkBlock,
    "--chain-id",
    String(BSC_CHAIN_ID),
    "--mnemonic",
    HARDHAT_MNEMONIC,
    "--accounts",
    "20",
    "--balance",
    "100",
    "--block-time",
    String(BSC_BLOCK_TIME_SECONDS),
    "--host",
    "127.0.0.1",
    "--port",
    "8545",
  ];
  if (process.env.LOCALTEST_ANVIL_VERBOSE !== "1") args.push("--quiet");
  log(`starting anvil BSC fork at block ${forkBlock} with ${BSC_BLOCK_TIME_SECONDS}s blocks`);
  const child = spawn("anvil", args, { stdio: "inherit" });
  child.on("error", (err) => fail(`failed to start anvil: ${err.message}`));
  return child;
}

function writeLocaltestFiles({ tokenAddress, vaultAddress, pairAddress, deploymentBlock, currentBlock, forkBlock }) {
  const manifest = {
    rpcUrl: LOCAL_RPC_URL,
    chainId: BSC_CHAIN_ID,
    blockTimeSeconds: BSC_BLOCK_TIME_SECONDS,
    mnemonic: "Hardhat default test mnemonic",
    owner: { index: 1, address: owner.address },
    operator: { index: 20, address: operator.address },
    accounts: accounts.map((account, i) => ({ index: i + 1, address: account.address })),
    tokenAddress,
    vaultAddress,
    pairAddress,
    routerAddress: BSC_ROUTER,
    burnAddress: BURN_ADDRESS,
    forkUrl,
    forkBlock,
    deploymentBlock: deploymentBlock.toString(),
    currentBlock: currentBlock.toString(),
    workerUrl: `http://127.0.0.1:${WORKER_PORT}`,
    initialLpBnb: INITIAL_LP_BNB,
    seedUscamexPerAccount: SEED_USCAMEX,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);

  writeFileSync(
    WORKER_CONFIG_PATH,
    `${JSON.stringify(
      {
        $schema: "node_modules/wrangler/config-schema.json",
        name: "uscamex-worker-localtest",
        main: "src/index.ts",
        compatibility_date: "2026-06-01",
        compatibility_flags: ["nodejs_compat"],
        observability: { enabled: true },
        assets: {
          directory: "../localtest/admin-dist",
          binding: "ASSETS",
          not_found_handling: "single-page-application",
          run_worker_first: ["/api/*"],
        },
        durable_objects: {
          bindings: [{ name: "OPERATOR", class_name: "OperatorDO" }],
        },
        migrations: [{ tag: "v1", new_sqlite_classes: ["OperatorDO"] }],
        d1_databases: [
          {
            binding: "DB",
            database_name: "uscamex_operator_localtest",
            database_id: "00000000-0000-0000-0000-000000000001",
            migrations_dir: "migrations",
          },
        ],
        vars: {
          CHAIN_ID: String(BSC_CHAIN_ID),
          TOKEN_ADDRESS: tokenAddress,
          PANCAKE_V2_ROUTER: BSC_ROUTER,
          BURN_ADDRESS,
          CONFIRMATIONS: "1",
          INDEXER_START_BLOCK: deploymentBlock.toString(),
          EXECUTOR_SLIPPAGE_BPS: "500",
          TRANSACTION_DEADLINE_SECONDS: "600",
          RPC_MAX_BLOCKS_PER_SCAN: "1000",
          RPC_CONFIG_TTL_SECS: "300",
          RPC_NODES_TTL_SECS: "60",
          RPC_RESERVES_TTL_SECS: "30",
          RPC_VAULT_BALANCE_TTL_SECS: "30",
          AMM_FEE_BPS: "9975",
          PUBLIC_RPC_URL: LOCAL_RPC_URL,
          CHAIN_NAME: "BSC Local Fork",
          EXPLORER_URL: LOCAL_RPC_URL,
          NATIVE_CURRENCY_NAME: "BNB",
          NATIVE_CURRENCY_SYMBOL: "BNB",
          NATIVE_CURRENCY_DECIMALS: "18",
        },
      },
      null,
      2,
    )}\n`,
  );

  writeFileSync(
    WORKER_DEV_VARS_PATH,
    `RPC_URL=${LOCAL_RPC_URL}\nOPERATOR_PRIVATE_KEY=${privateKeyOf(19)}\n`,
    { mode: 0o600 },
  );
}

function injectAdminLocaltestWallet() {
  const indexPath = join(LOCALTEST_ADMIN_DIST, "index.html");
  if (!existsSync(indexPath)) fail("admin dist/index.html not found after build");
  const config = {
    chainId: BSC_CHAIN_ID,
    rpcUrl: LOCAL_RPC_URL,
    accounts: accounts.map((account, i) => ({
      index: i + 1,
      address: account.address,
      privateKey: privateKeyOf(i),
    })),
  };
  const script = `<script>window.__USCAMEX_LOCALTEST_WALLET__=${JSON.stringify(config)};</script>`;
  const html = readFileSync(indexPath, "utf8");
  if (html.includes("__USCAMEX_LOCALTEST_WALLET__")) return;
  writeFileSync(indexPath, html.replace("<script", `${script}\n    <script`));
}

function prepareLocaltestAdminDist() {
  const source = join(TOKEN_DIR, "admin/dist");
  if (!existsSync(source)) fail("admin dist not found after build");
  rmSync(LOCALTEST_ADMIN_DIST, { recursive: true, force: true });
  mkdirSync(LOCALTEST_ADMIN_DIST, { recursive: true });
  cpSync(source, LOCALTEST_ADMIN_DIST, { recursive: true });
}

function resetLocalWorkerState() {
  log("resetting local worker/D1 state");
  rmSync(WORKER_LOCAL_DIR, { recursive: true, force: true });
}

function startLocalCron(workerUrl) {
  if (!Number.isFinite(LOCALTEST_CRON_INTERVAL_MS) || LOCALTEST_CRON_INTERVAL_MS <= 0) {
    log("local cron auto-trigger disabled");
    return;
  }
  const scheduledUrl = `${workerUrl}/__scheduled?cron=*+*+*+*+*`;
  log(`auto-triggering local cron every ${LOCALTEST_CRON_INTERVAL_MS}ms`);

  const schedule = (delayMs) => {
    const timer = setTimeout(async () => {
      timers.delete(timer);
      try {
        const res = await fetch(scheduledUrl);
        if (!res.ok) log(`local cron trigger failed: HTTP ${res.status}`);
      } catch (err) {
        log(`local cron trigger failed: ${err.message}`);
      }
      schedule(LOCALTEST_CRON_INTERVAL_MS);
    }, delayMs);
    timers.add(timer);
  };

  schedule(1_000);
}

async function resolveForkBlockNumber() {
  if (process.env.LOCALTEST_FORK_BLOCK_NUMBER) return process.env.LOCALTEST_FORK_BLOCK_NUMBER;
  const blockHex = await rawRpc(forkUrl, "eth_blockNumber", []);
  return BigInt(blockHex).toString();
}

async function rawRpc(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) fail(`fork RPC ${method} failed with HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) fail(`fork RPC ${method} failed: ${body.error.message}`);
  return body.result;
}

function readArtifact() {
  const raw = JSON.parse(readFileSync(join(TOKEN_DIR, "out/USCAMEX.sol/USCAMEX.json"), "utf8"));
  const bytecode = raw.bytecode?.object || raw.bytecode;
  if (!bytecode || bytecode === "0x") fail("USCAMEX artifact bytecode is empty; forge build likely failed");
  return { abi: raw.abi, bytecode: bytecode.startsWith("0x") ? bytecode : `0x${bytecode}` };
}

function accountAt(addressIndex) {
  return mnemonicToAccount(HARDHAT_MNEMONIC, { addressIndex });
}

function privateKeyOf(addressIndex) {
  const key = accountAt(addressIndex).getHdKey().privateKey;
  if (!key) fail(`could not derive private key for account #${addressIndex + 1}`);
  return `0x${Buffer.from(key).toString("hex")}`;
}

async function waitForRpc(rpcUrl) {
  const client = createPublicClient({ chain: bscLocal, transport: http(rpcUrl) });
  for (let i = 0; i < 60; i += 1) {
    try {
      const block = await client.getBlockNumber();
      log(`anvil ready at block ${block}`);
      return;
    } catch {
      await sleep(1000);
    }
  }
  fail("timed out waiting for anvil RPC");
}

async function waitForHttp(url) {
  for (let i = 0; i < 90; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // keep waiting
    }
    await sleep(1000);
  }
  fail(`timed out waiting for ${url}`);
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match || process.env[match[1]] != null) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function shutdown() {
  for (const timer of timers) clearTimeout(timer);
  for (const child of children) child.kill("SIGTERM");
  process.exit(0);
}

function log(message) {
  console.log(`[localtest] ${message}`);
}

function fail(message) {
  console.error(`[localtest] ${message}`);
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
