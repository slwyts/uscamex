"use client";

import Image from "next/image";
import { FadeUp, StaggerContainer, StaggerItem } from "./Animations";

export default function ArenaSection() {
  return (
    <section className="relative px-5 py-20 text-white">
      <div className="max-w-[1200px] mx-auto">
        {/* Section heading - two column layout */}
        <FadeUp className="flex flex-col md:flex-row md:items-end md:justify-between gap-6 mb-14">
          <h2 className="text-[32px] md:text-[44px] lg:text-[56px] font-bold tracking-[-0.03em] leading-[1.1] gradient-text max-w-[600px]">
            Welcome to the skill based sports arena.
          </h2>
          <p className="text-white/55 text-[15px] max-w-[340px] leading-[1.6] md:text-right">
            It all starts here. Build your squad, enter tournaments, climb the
            leaderboards, and earn rewards.
          </p>
        </FadeUp>

        <StaggerContainer className="flex flex-col gap-5">
          {/* Main football card */}
          <StaggerItem>
            <a
              href="https://www.football.fun/"
              className="group block relative rounded-[20px] overflow-hidden bg-[#0a0a0a] border border-white/[0.06] hover:border-white/[0.12] transition-all duration-300 hover:-translate-y-1"
            >
              <div className="flex flex-col md:flex-row items-center">
                <div className="p-8 md:p-10 lg:p-12 flex-1">
                  <span className="text-[13px] text-white/40 uppercase tracking-[0.1em] font-medium">
                    Football
                  </span>
                  <p className="mt-3 text-white/55 text-[15px] leading-[1.6] max-w-[420px]">
                    Pick players. Compete in real match tournaments. Climb the
                    leaderboard and earn TP.
                  </p>
                </div>
                <div className="w-full md:w-[55%] p-4 md:p-6">
                  <Image
                    src="/images/football-card.png"
                    alt="Football"
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
            {/* NFL card */}
            <StaggerItem>
              <div className="rounded-[20px] overflow-hidden bg-[#0a0a0a] border border-white/[0.06] p-6 md:p-7 flex flex-col h-full hover:border-white/[0.12] transition-all duration-300 hover:-translate-y-1">
                <h4 className="text-[18px] font-semibold">NFL</h4>
                <p className="mt-2 text-white/55 text-[14px] leading-[1.6]">
                  Back your NFL picks each week. Place higher. Win TP. Repeat.
                </p>
                <div className="mt-auto pt-6">
                  <Image
                    src="/images/nfl-card.png"
                    alt="NFL"
                    width={572}
                    height={526}
                    className="w-full h-auto rounded-xl"
                  />
                </div>
              </div>
            </StaggerItem>

            {/* $FUN token card */}
            <StaggerItem>
              <div className="rounded-[20px] overflow-hidden bg-[#0a0a0a] border border-white/[0.06] p-6 md:p-7 flex flex-col h-full hover:border-white/[0.12] transition-all duration-300 hover:-translate-y-1">
                <h4 className="text-[18px] font-semibold">Time for $FUN</h4>
                <p className="mt-2 text-white/55 text-[14px] leading-[1.6]">
                  Hold $FUN to unlock fee rebates, bonus TP, and ecosystem-wide
                  perks.
                </p>
                <div className="mt-auto pt-6">
                  <Image
                    src="/images/fun-token-card.png"
                    alt="$FUN Token"
                    width={576}
                    height={524}
                    className="w-full h-auto rounded-xl"
                  />
                </div>
              </div>
            </StaggerItem>

            {/* What's Next card */}
            <StaggerItem>
              <div className="rounded-[20px] overflow-hidden bg-[#0a0a0a] border border-white/[0.06] p-6 md:p-7 flex flex-col h-full hover:border-white/[0.12] transition-all duration-300 hover:-translate-y-1">
                <h4 className="text-[18px] font-semibold">
                  What&apos;s Next?
                </h4>
                <p className="mt-2 text-white/55 text-[14px] leading-[1.6]">
                  More sports coming. Same competition. Bigger arenas.
                </p>
                <div className="mt-auto pt-6 flex items-center justify-center">
                  <Image
                    src="/images/whats-next-card.svg"
                    alt="What's Next"
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
