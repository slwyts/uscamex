"use client";

import Image from "next/image";
import { FadeUp, StaggerContainer, StaggerItem } from "./Animations";
import { useLocale } from "@/i18n/context";

export default function ArenaSection() {
  const { t } = useLocale();

  return (
    <section id="predictions" className="relative px-5 py-20 text-white">
      <div className="max-w-[1200px] mx-auto">
        {/* Section heading - two column layout */}
        <FadeUp className="flex flex-col md:flex-row md:items-end md:justify-between gap-6 mb-14">
          <h2 className="text-[32px] md:text-[44px] lg:text-[56px] font-bold tracking-[-0.03em] leading-[1.1] gradient-text max-w-[600px]">
            {t("arena.title")}
          </h2>
          <p className="text-white/55 text-[15px] max-w-[380px] leading-[1.6] md:text-right">
            {t("arena.subtitle")}
          </p>
        </FadeUp>

        <StaggerContainer className="flex flex-col gap-5">
          {/* Main football card */}
          <StaggerItem>
            <a
              href="#"
              className="group block relative rounded-[20px] overflow-hidden bg-[#111118] border border-white/[0.06] hover:border-[#f5c842]/20 transition-all duration-300 hover:-translate-y-1"
            >
              <div className="flex flex-col md:flex-row items-center">
                <div className="p-8 md:p-10 lg:p-12 flex-1">
                  <span className="inline-flex items-center gap-2 text-[13px] text-[#f5c842]/70 uppercase tracking-[0.1em] font-medium">
                    <span className="w-2 h-2 rounded-full bg-[#10b981] pulse-glow" />
                    {t("arena.sportLabel")}
                  </span>
                  <p className="mt-3 text-white/55 text-[15px] leading-[1.6] max-w-[420px]">
                    {t("arena.sportDesc")}
                  </p>
                </div>
                <div className="w-full md:w-[55%] p-4 md:p-6">
                  <Image
                    src="/images/football-card.png"
                    alt={t("arena.sportLabel")}
                    width={800}
                    height={680}
                    className="w-full h-auto rounded-2xl"
                  />
                </div>
              </div>
            </a>
          </StaggerItem>

          {/* 3-column grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {/* Fan Token card */}
            <StaggerItem>
              <div className="rounded-[20px] overflow-hidden bg-[#111118] border border-white/[0.06] p-6 md:p-7 flex flex-col h-full hover:border-[#f5c842]/20 transition-all duration-300 hover:-translate-y-1">
                <h4 className="text-[18px] font-semibold">{t("arena.fanTitle")}</h4>
                <p className="mt-2 text-white/55 text-[14px] leading-[1.6]">
                  {t("arena.fanDesc")}
                </p>
                <div className="mt-auto pt-6">
                  <Image
                    src="/images/nfl-card.png"
                    alt={t("arena.fanTitle")}
                    width={572}
                    height={526}
                    className="w-full h-auto rounded-xl"
                  />
                </div>
              </div>
            </StaggerItem>

            {/* $USCAMEX token card */}
            <StaggerItem>
              <div className="rounded-[20px] overflow-hidden bg-[#111118] border border-white/[0.06] p-6 md:p-7 flex flex-col h-full hover:border-[#f5c842]/20 transition-all duration-300 hover:-translate-y-1">
                <h4 className="text-[18px] font-semibold">{t("arena.tokenTitle")}</h4>
                <p className="mt-2 text-white/55 text-[14px] leading-[1.6]">
                  {t("arena.tokenDesc")}
                </p>
                <div className="mt-auto pt-6">
                  <Image
                    src="/images/fun-token-card.png"
                    alt="$USCAMEX Token"
                    width={576}
                    height={524}
                    className="w-full h-auto rounded-xl"
                  />
                </div>
              </div>
            </StaggerItem>

            {/* What's Next card */}
            <StaggerItem>
              <div className="rounded-[20px] overflow-hidden bg-[#111118] border border-white/[0.06] p-6 md:p-7 flex flex-col h-full hover:border-[#f5c842]/20 transition-all duration-300 hover:-translate-y-1">
                <h4 className="text-[18px] font-semibold">
                  {t("arena.web3Title")}
                </h4>
                <p className="mt-2 text-white/55 text-[14px] leading-[1.6]">
                  {t("arena.web3Desc")}
                </p>
                <div className="mt-auto pt-6 flex items-center justify-center">
                  <Image
                    src="/images/whats-next-card.svg"
                    alt="Web3"
                    width={268}
                    height={364}
                    className="w-full max-w-[180px] h-auto"
                  />
                </div>
              </div>
            </StaggerItem>
          </div>
        </StaggerContainer>
      </div>
    </section>
  );
}
