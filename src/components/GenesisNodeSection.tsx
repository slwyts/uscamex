"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { FadeUp } from "./Animations";
import { useLocale } from "@/i18n/context";

const NODE_ADDRESS = "0x3705Ea089E280DBB9e2F42C72983ABC7094B720d";
// BSC 主网 Chain ID = 56 (0x38)
const BSC_CHAIN_ID_HEX = "0x38";
const BSC_CHAIN_PARAMS = {
  chainId: BSC_CHAIN_ID_HEX,
  chainName: "BNB Smart Chain",
  nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
  rpcUrls: ["https://bsc-dataseed.binance.org/"],
  blockExplorerUrls: ["https://bscscan.com"],
};
// 1 BNB = 10^18 wei = 0xDE0B6B3A7640000
const ONE_BNB_WEI_HEX = "0xDE0B6B3A7640000";

type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
};

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

const tiers = [
  {
    nameKey: "node.tier.starter.name",
    descKey: "node.tier.starter.desc",
    amount: "1",
    weight: 1,
    accent: "from-[#f5c842]/15 to-transparent",
    ring: "ring-[#f5c842]/25",
  },
] as const;

export default function GenesisNodeSection() {
  const [copied, setCopied] = useState(false);
  const [minting, setMinting] = useState(false);
  const [statusKey, setStatusKey] = useState<string | null>(null);
  const [statusTone, setStatusTone] = useState<"info" | "success" | "error">("info");
  const [txHash, setTxHash] = useState<string | null>(null);
  const { t } = useLocale();

  const handleCopy = () => {
    navigator.clipboard.writeText(NODE_ADDRESS);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const showStatus = (key: string, tone: "info" | "success" | "error" = "info") => {
    setStatusKey(key);
    setStatusTone(tone);
  };

  const handleMint = async () => {
    if (minting) return;
    setTxHash(null);
    const provider = typeof window !== "undefined" ? window.ethereum : undefined;
    if (!provider) {
      showStatus("node.noWallet", "error");
      return;
    }
    setMinting(true);
    try {
      // 1. 请求账户连接
      showStatus("node.connecting", "info");
      const accounts = (await provider.request({
        method: "eth_requestAccounts",
      })) as string[];
      const from = accounts?.[0];
      if (!from) {
        showStatus("node.userRejected", "error");
        return;
      }

      // 2. 检查并切换到 BSC 主网
      const currentChainId = (await provider.request({ method: "eth_chainId" })) as string;
      if (currentChainId?.toLowerCase() !== BSC_CHAIN_ID_HEX) {
        showStatus("node.switching", "info");
        try {
          await provider.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: BSC_CHAIN_ID_HEX }],
          });
        } catch (switchErr) {
          const code = (switchErr as { code?: number })?.code;
          // 4902 = 链未添加，尝试添加
          if (code === 4902) {
            try {
              await provider.request({
                method: "wallet_addEthereumChain",
                params: [BSC_CHAIN_PARAMS],
              });
            } catch {
              showStatus("node.wrongChain", "error");
              return;
            }
          } else if (code === 4001) {
            showStatus("node.userRejected", "error");
            return;
          } else {
            showStatus("node.wrongChain", "error");
            return;
          }
        }
        // 二次校验
        const verifyChainId = (await provider.request({ method: "eth_chainId" })) as string;
        if (verifyChainId?.toLowerCase() !== BSC_CHAIN_ID_HEX) {
          showStatus("node.wrongChain", "error");
          return;
        }
      }

      // 3. 发起转账：向合约地址转 1 BNB
      showStatus("node.minting", "info");
      const hash = (await provider.request({
        method: "eth_sendTransaction",
        params: [
          {
            from,
            to: NODE_ADDRESS,
            value: ONE_BNB_WEI_HEX,
          },
        ],
      })) as string;
      setTxHash(hash);
      showStatus("node.mintSuccess", "success");
    } catch (err) {
      const code = (err as { code?: number })?.code;
      if (code === 4001) {
        showStatus("node.userRejected", "error");
      } else {
        showStatus("node.mintFailed", "error");
      }
    } finally {
      setMinting(false);
    }
  };

  return (
    <section
      id="node-sale"
      className="relative px-5 py-20 md:py-28 text-white overflow-hidden"
    >
      {/* Glow backdrop */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10 pointer-events-none"
        style={{
          background:
            "radial-gradient(60% 50% at 50% 30%, rgba(245,200,66,0.10) 0%, rgba(245,200,66,0.02) 45%, transparent 70%)",
        }}
      />
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 -z-10 h-px bg-gradient-to-r from-transparent via-[#f5c842]/30 to-transparent"
      />

      <div className="max-w-[1200px] mx-auto">
        <FadeUp className="text-center max-w-[720px] mx-auto">
          <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-[#f5c842]/30 bg-[#f5c842]/8 text-[12px] font-medium text-[#f5c842] tracking-wider uppercase">
            <span className="w-1.5 h-1.5 rounded-full bg-[#f5c842] animate-pulse" />
            {t("node.badge")}
          </span>
          <h2 className="mt-5 text-[28px] md:text-[44px] font-bold tracking-[-0.02em] leading-[1.15] gradient-text">
            {t("node.title")}
          </h2>
          <p className="mt-5 text-white/55 text-[15px] md:text-[16px] leading-[1.7]">
            {t("node.desc")}
          </p>
        </FadeUp>

        {/* Tier card */}
        <div className="mt-12 max-w-[420px] mx-auto">
          {tiers.map((tier, i) => (
            <FadeUp key={tier.nameKey} delay={i * 0.08}>
              <motion.div
                whileHover={{ y: -4 }}
                transition={{ type: "spring", stiffness: 300, damping: 20 }}
                className={`relative rounded-2xl border border-white/[0.08] bg-[#0f0f17]/80 backdrop-blur-sm p-6 md:p-7 ring-1 ${tier.ring} shadow-[0_24px_64px_-24px_rgba(245,200,66,0.35)]`}
              >
                {/* tier accent gradient */}
                <div
                  aria-hidden
                  className={`absolute inset-0 -z-10 rounded-2xl bg-gradient-to-b ${tier.accent} opacity-70`}
                />

                <div className="flex items-baseline justify-between">
                  <h3 className="text-[18px] md:text-[20px] font-bold text-white">
                    {t(tier.nameKey as never)}
                  </h3>
                  <span className="text-[12px] text-white/40">
                    ×{tier.weight} {t("node.tier.weightUnit")}
                  </span>
                </div>

                <p className="mt-2 text-[13px] text-white/50 leading-[1.6] min-h-[40px]">
                  {t(tier.descKey as never)}
                </p>

                <div className="mt-6 flex items-baseline gap-1">
                  <span className="text-[36px] md:text-[40px] font-bold text-[#f5c842] leading-none">
                    {tier.amount}
                  </span>
                  <span className="text-[14px] font-medium text-white/60">
                    BNB
                  </span>
                </div>

                <ul className="mt-5 space-y-2 text-[12.5px] text-white/55">
                  <li className="flex items-start gap-2">
                    <Dot /> {t("node.bullet.share")}
                  </li>
                  <li className="flex items-start gap-2">
                    <Dot /> {t("node.bullet.passive")}
                  </li>
                  <li className="flex items-start gap-2">
                    <Dot /> {t("node.bullet.priority")}
                  </li>
                </ul>
              </motion.div>
            </FadeUp>
          ))}
        </div>

        {/* Subscribe address */}
        <FadeUp className="mt-12">
          <div className="rounded-2xl border border-[#f5c842]/15 bg-gradient-to-br from-[#15151f] to-[#0c0c12] p-5 md:p-7">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <div>
                <p className="text-[12px] uppercase tracking-wider text-[#f5c842]/80 font-semibold">
                  {t("node.address.label")}
                </p>
                <p className="mt-1 text-[13px] text-white/50">
                  {t("node.address.note")}
                </p>
              </div>
              <a
                href="/whitepaper.pdf"
                target="_blank"
                rel="noopener"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-white/15 bg-white/5 text-[13px] font-medium text-white/80 hover:text-[#f5c842] hover:border-[#f5c842]/40 transition-colors"
              >
                <PdfIcon />
                {t("node.whitepaper.cta")}
              </a>
            </div>

            <div className="mt-5 flex flex-col sm:flex-row gap-3 items-stretch">
              <code className="flex-1 px-4 py-3 rounded-xl bg-[#0a0a0f] border border-white/[0.08] text-[#f5c842] font-mono text-[13px] md:text-[14px] break-all">
                {NODE_ADDRESS}
              </code>
              <button
                onClick={handleCopy}
                className="px-6 py-3 rounded-xl bg-white/5 border border-white/10 text-[14px] font-bold text-white/85 hover:text-[#f5c842] hover:border-[#f5c842]/40 transition-colors duration-200 cursor-pointer"
              >
                {copied ? t("node.copied") : t("node.copy")}
              </button>
            </div>

            {/* 一键铸造按钮 */}
            <div className="mt-4">
              <button
                onClick={handleMint}
                disabled={minting}
                className="w-full px-6 py-3.5 rounded-xl bg-[#f5c842] text-[#0a0a0f] text-[15px] font-bold hover:bg-[#f5c842]/90 transition-colors duration-200 cursor-pointer shadow-[0_0_24px_rgba(245,200,66,0.25)] disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2"
              >
                <BoltIcon />
                {minting ? t("node.minting" as never) : t("node.mint" as never)}
              </button>

              {statusKey && (
                <div
                  className={`mt-3 rounded-lg px-3 py-2 text-[12.5px] border ${
                    statusTone === "success"
                      ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
                      : statusTone === "error"
                      ? "border-red-400/30 bg-red-400/10 text-red-300"
                      : "border-white/10 bg-white/5 text-white/70"
                  }`}
                >
                  {t(statusKey as never)}
                  {txHash && (
                    <>
                      {" · "}
                      <a
                        href={`https://bscscan.com/tx/${txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline break-all"
                      >
                        {txHash.slice(0, 10)}…{txHash.slice(-8)}
                      </a>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </FadeUp>
      </div>
    </section>
  );
}

function Dot() {
  return (
    <span className="mt-1.5 inline-block w-1 h-1 rounded-full bg-[#f5c842]/70 flex-shrink-0" />
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-white/[0.02] border border-white/[0.05] px-3 py-2.5">
      <p className="text-[11px] uppercase tracking-wider text-white/35">
        {label}
      </p>
      <p className="mt-0.5 text-[13px] font-semibold text-white/85">{value}</p>
    </div>
  );
}

function PdfIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="9" y1="13" x2="15" y2="13" />
      <line x1="9" y1="17" x2="15" y2="17" />
    </svg>
  );
}

function BoltIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />
    </svg>
  );
}
