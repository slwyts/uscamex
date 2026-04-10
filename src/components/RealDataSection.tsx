"use client";

import Image from "next/image";
import { FadeUp, ScaleIn } from "./Animations";

export default function RealDataSection() {
  return (
    <section className="relative px-5 py-20 text-white">
      <div className="max-w-[1200px] mx-auto">
        <ScaleIn>
          <div className="rounded-[20px] overflow-hidden bg-[#0a0a0a] border border-white/[0.06] relative">
            <div className="flex flex-col lg:flex-row">
              {/* Left content */}
              <div className="flex-1 p-8 md:p-10 lg:p-14 flex flex-col justify-center">
                <FadeUp>
                  <h2 className="text-[28px] md:text-[36px] lg:text-[48px] font-bold tracking-[-0.03em] leading-[1.1] gradient-text">
                    Real matches. Real data. Real outcomes.
                  </h2>
                </FadeUp>
                <FadeUp delay={0.1}>
                  <p className="mt-6 text-white/55 text-[15px] leading-[1.6] max-w-[480px]">
                    Every tournament on Sport.Fun is powered by real-world
                    performances. Scores, rankings, and rewards are calculated
                    using official sports data providers, Opta and Sportradar,
                    ensuring accuracy, transparency, and fairness across every
                    competition.
                  </p>
                </FadeUp>

                {/* Data provider badges */}
                <FadeUp delay={0.2}>
                  <div className="mt-8 flex flex-col gap-4">
                    <div className="flex items-center">
                      <Image
                        src="/images/live-scoring.png"
                        alt="Live scoring from fixtures"
                        width={1533}
                        height={308}
                        className="h-8 w-auto"
                      />
                    </div>
                    <div className="flex items-center">
                      <Image
                        src="/images/opta-data.png"
                        alt="Powered by Opta data"
                        width={1533}
                        height={308}
                        className="h-8 w-auto"
                      />
                    </div>
                    <div className="flex items-center">
                      <Image
                        src="/images/sportradar-data.png"
                        alt="Powered by Sportradar"
                        width={1533}
                        height={308}
                        className="h-8 w-auto"
                      />
                    </div>
                  </div>
                </FadeUp>
              </div>

              {/* Right image */}
              <div className="flex-1 relative min-h-[300px] lg:min-h-[520px]">
                <Image
                  src="/images/data-section-bg.png"
                  alt="Real data visualization"
                  fill sizes="100vw"
                  className="object-cover object-center"
                />
              </div>
            </div>
          </div>
        </ScaleIn>
      </div>
    </section>
  );
}
