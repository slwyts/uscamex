import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  formatUnits,
  http,
  isAddress,
  parseEther,
  parseUnits,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";

const HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN_DIR = join(ROOT, "Token");
const MANIFEST_PATH = join(TOKEN_DIR, "localtest/manifest.json");
const ARTIFACT_PATH = join(TOKEN_DIR, "out/USCAMEX.sol/USCAMEX.json");

if (!existsSync(MANIFEST_PATH)) {
  console.error("localtest manifest not found. Run `pnpm run localtest` first.");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, "utf8"));
const chain = {
  id: manifest.chainId,
  name: "BSC Local Fork",
  nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
  rpcUrls: { default: { http: [manifest.rpcUrl] } },
};
const publicClient = createPublicClient({ chain, transport: http(manifest.rpcUrl) });
const accounts = Array.from({ length: 20 }, (_, i) => mnemonicToAccount(HARDHAT_MNEMONIC, { addressIndex: i }));
const rl = createInterface({ input, output });

await main();

async function main() {
  console.log(`USCAMEX localtest wallet`);
  console.log(`RPC   ${manifest.rpcUrl}`);
  console.log(`Token ${manifest.tokenAddress}`);
  console.log(`Vault ${manifest.vaultAddress}`);

  let selected = await chooseAccount();
  while (true) {
    console.log(`\nsource #${selected + 1}: ${accounts[selected].address}`);
    const action = (await ask("[b]alances, [t]ransfer, [s]witch account, [q]uit: ")).toLowerCase();
    if (action === "q" || action === "quit") break;
    if (action === "s" || action === "switch") {
      selected = await chooseAccount();
      continue;
    }
    if (action === "b" || action === "balance" || action === "balances") {
      await showBalances(selected);
      continue;
    }
    if (action === "t" || action === "transfer") {
      await transfer(selected).catch((err) => console.error(`transfer failed: ${err.shortMessage || err.message}`));
      continue;
    }
    console.log("unknown action");
  }
  rl.close();
}

async function chooseAccount() {
  console.log("\nAccounts:");
  for (const [i, account] of accounts.entries()) {
    const label = i === 0 ? "owner" : i === 19 ? "operator" : "";
    console.log(`${String(i + 1).padStart(2, " ")}. ${account.address}${label ? ` (${label})` : ""}`);
  }
  while (true) {
    const raw = await ask("choose source account #1-20: ");
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 20) return n - 1;
    console.log("enter a number from 1 to 20");
  }
}

async function showBalances(index) {
  const address = accounts[index].address;
  const [bnb, token, vaultBnb, contractBnb] = await Promise.all([
    publicClient.getBalance({ address }),
    publicClient.readContract({ address: manifest.tokenAddress, abi: artifact.abi, functionName: "balanceOf", args: [address] }),
    publicClient.getBalance({ address: manifest.vaultAddress }),
    publicClient.getBalance({ address: manifest.tokenAddress }),
  ]);
  console.log(`#${index + 1} ${address}`);
  console.log(`BNB:    ${formatEther(bnb)}`);
  console.log(`USCAMEX: ${formatUnits(token, 18)}`);
  console.log(`Vault BNB:          ${formatEther(vaultBnb)}`);
  console.log(`Token contract BNB: ${formatEther(contractBnb)}`);
}

async function transfer(index) {
  const source = accounts[index];
  const walletClient = createWalletClient({ account: source, chain, transport: http(manifest.rpcUrl) });
  const asset = (await ask("asset [bnb/uscamex]: ")).trim().toLowerCase();
  const to = await chooseDestination();
  const rawAmount = await ask("amount: ");
  if (asset === "bnb") {
    const hash = await walletClient.sendTransaction({ to, value: parseEther(rawAmount) });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`BNB transfer confirmed: ${receipt.transactionHash}`);
    return;
  }
  if (asset === "uscamex" || asset === "token") {
    const amount = parseUnits(rawAmount, 18);
    const hash = await walletClient.writeContract({
      address: manifest.tokenAddress,
      abi: artifact.abi,
      functionName: "transfer",
      args: [to, amount],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`USCAMEX transfer confirmed: ${receipt.transactionHash}`);
    return;
  }
  throw new Error("asset must be bnb or uscamex");
}

async function chooseDestination() {
  console.log("destinations:");
  console.log(`  token    ${manifest.tokenAddress}`);
  console.log(`  vault    ${manifest.vaultAddress}`);
  console.log("  #1-#20   local accounts");
  console.log("  0x...    custom address");
  while (true) {
    const raw = (await ask("to: ")).trim();
    const lower = raw.toLowerCase();
    if (lower === "token" || lower === "contract") return manifest.tokenAddress;
    if (lower === "vault" || lower === "warehouse") return manifest.vaultAddress;
    const numberText = lower.startsWith("#") ? lower.slice(1) : lower;
    const n = Number(numberText);
    if (Number.isInteger(n) && n >= 1 && n <= 20) return accounts[n - 1].address;
    if (isAddress(raw)) return raw;
    console.log("enter token, vault, #1-#20, or a 0x address");
  }
}

async function ask(prompt) {
  return (await rl.question(prompt)).trim();
}
