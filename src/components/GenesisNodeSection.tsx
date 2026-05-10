"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { FadeUp } from "./Animations";
import { useLocale } from "@/i18n/context";

const NODE_ADDRESS = "0x776289d56b7e4A6FBc85Ba64F851Cae2351d3a49";

const tiers = [
  {
    nameKey: "node.tier.starter.name",
    descKey: "node.tier.starter.desc",
    amount: "0.5",
    weight: 1,
    accent: "from-[#f5c842]/15 to-transparent",
    ring: "ring-[#f5c842]/25",
  },
  {
    nameKey: "node.tier.super.name",
    descKey: "node.tier.super.desc",
    amount: "1.5",
    weight: 3,
    accent: "from-[#ff8c42]/20 via-[#f5c842]/10 to-transparent",
    ring: "ring-[#f5c842]/45",
    highlight: true,
  },
  {
    nameKey: "node.tier.genesis.name",
    descKey: "node.tier.genesis.desc",
    amount: "5.0",
    weight: 10,
    accent: "from-[#9b6cff]/20 via-[#f5c842]/10 to-transparent",
    ring: "ring-[#f5c842]/30",
  },
] as const;

export default function GenesisNodeSection() {
  const [copied, setCopied] = useState(false);
  const { t } = useLocale();

  const handleCopy = () => {
    navigator.clipboard.writeText(NODE_ADDRESS);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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

        {/* Tier cards */}
        <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-5">
          {tiers.map((tier, i) => (
            <FadeUp key={tier.nameKey} delay={i * 0.08}>
              <motion.div
                whileHover={{ y: -4 }}
                transition={{ type: "spring", stiffness: 300, damping: 20 }}
                className={`relative rounded-2xl border border-white/[0.08] bg-[#0f0f17]/80 backdrop-blur-sm p-6 md:p-7 ring-1 ${tier.ring} ${
                  "highlight" in tier && tier.highlight
                    ? "md:scale-[1.03] md:-translate-y-1 shadow-[0_24px_64px_-24px_rgba(245,200,66,0.35)]"
                    : ""
                }`}
              >
                {/* tier accent gradient */}
                <div
                  aria-hidden
                  className={`absolute inset-0 -z-10 rounded-2xl bg-gradient-to-b ${tier.accent} opacity-70`}
                />

                {"highlight" in tier && tier.highlight && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-full bg-[#f5c842] text-[#0a0a0f] text-[11px] font-bold tracking-wider">
                    {t("node.tier.recommended")}
                  </span>
                )}

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
                className="px-6 py-3 rounded-xl bg-[#f5c842] text-[#0a0a0f] text-[14px] font-bold hover:bg-[#f5c842]/90 transition-colors duration-200 cursor-pointer shadow-[0_0_24px_rgba(245,200,66,0.25)]"
              >
                {copied ? t("node.copied") : t("node.copy")}
              </button>
            </div>

            <div className="mt-5 grid grid-cols-2 md:grid-cols-4 gap-3">
              <Fact label={t("node.fact.network")} value="BNB Chain" />
              <Fact label={t("node.fact.range")} value="0.1 — 5 BNB" />
              <Fact label={t("node.fact.referral")} value={t("node.fact.referralValue")} />
              <Fact label={t("node.fact.payout")} value={t("node.fact.payoutValue")} />
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
