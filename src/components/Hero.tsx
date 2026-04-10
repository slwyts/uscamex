"use client";

import Image from "next/image";
import { motion } from "framer-motion";

const springAppear = {
  type: "spring" as const,
  stiffness: 195,
  damping: 30,
  mass: 1,
};

export default function Hero() {
  return (
    <section className="relative flex flex-col items-center overflow-hidden pt-28 pb-20">
      {/* Background decorative cloud/mist at top */}
      <div className="absolute inset-0 z-0 pointer-events-none">
        <Image
          src="/images/hero-bg.png"
          alt=""
          fill
          className="object-cover object-top opacity-60"
          priority
        />
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-[#f5f5f5]/50 to-[#f5f5f5]" />
      </div>

      <div className="relative z-10 flex flex-col items-center text-center max-w-4xl mx-auto px-5">
        {/* Heading */}
        <motion.h1
          initial={{ opacity: 0, scale: 0.5 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ ...springAppear, delay: 0.1 }}
          className="text-[52px] md:text-[72px] lg:text-[96px] font-bold tracking-[-0.04em] leading-[1.05] gradient-text-dark"
        >
          Pick,
          <br />
          Compete,
          <br />
          Win.
        </motion.h1>

        {/* Phone mockup */}
        <motion.div
          initial={{ opacity: 0, scale: 0.5 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ ...springAppear, delay: 0.2 }}
          className="relative mt-10 w-full max-w-[320px] md:max-w-[380px]"
        >
          {/* Floating decorative elements */}
          <div className="absolute -left-[140px] top-[15%] hidden lg:flex flex-col gap-8">
            <div className="flex -space-x-3">
              <div className="w-10 h-10 rounded-full bg-[#1a3a5c] border-2 border-white shadow-md" />
              <div className="w-10 h-10 rounded-full bg-[#c0392b] border-2 border-white shadow-md" />
              <div className="w-10 h-10 rounded-full bg-[#8e44ad] border-2 border-white shadow-md" />
            </div>
            <div className="flex -space-x-3">
              <div className="w-10 h-10 rounded-full bg-[#e74c3c] border-2 border-white shadow-md" />
              <div className="w-10 h-10 rounded-full bg-[#27ae60] border-2 border-white shadow-md" />
              <div className="w-10 h-10 rounded-full bg-[#2980b9] border-2 border-white shadow-md" />
            </div>
            <div className="flex items-center gap-2 bg-white/80 backdrop-blur-sm rounded-full px-3 py-1.5 shadow-sm">
              <span className="text-[13px] font-medium text-[#121111]/60">
                TP
              </span>
              <span className="text-[15px] font-semibold text-[#121111]">
                12,269,420
              </span>
            </div>
          </div>

          <div className="absolute -right-[140px] top-[15%] hidden lg:flex flex-col gap-8 items-end">
            <div className="flex items-center gap-2 bg-white/80 backdrop-blur-sm rounded-full px-3 py-1.5 shadow-sm">
              <span className="text-[15px] font-semibold text-[#121111]">
                20,900
              </span>
              <span className="text-[13px] font-medium text-[#121111]/60">
                $FUN
              </span>
            </div>
            <div className="flex -space-x-3">
              <div className="w-10 h-10 rounded-full bg-[#34495e] border-2 border-white shadow-md" />
              <div className="w-10 h-10 rounded-full bg-[#f39c12] border-2 border-white shadow-md" />
              <div className="w-10 h-10 rounded-full bg-[#1abc9c] border-2 border-white shadow-md" />
            </div>
            <div className="flex -space-x-3">
              <div className="w-10 h-10 rounded-full bg-[#2ecc71] border-2 border-white shadow-md" />
              <div className="w-10 h-10 rounded-full bg-[#e67e22] border-2 border-white shadow-md" />
              <div className="w-10 h-10 rounded-full bg-[#9b59b6] border-2 border-white shadow-md" />
            </div>
          </div>

          <Image
            src="/images/hero-phone.png"
            alt="Sport.Fun app"
            width={975}
            height={2220}
            className="w-full h-auto drop-shadow-[0_20px_60px_rgba(0,0,0,0.15)]"
            priority
          />
        </motion.div>

        {/* Description */}
        <motion.p
          initial={{ opacity: 0, scale: 0.5 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ ...springAppear, delay: 0.3 }}
          className="mt-10 text-[15px] md:text-[17px] text-[#121111]/55 max-w-[580px] leading-[1.6]"
        >
          Sport.Fun is a skill-based sports competition platform. Build your
          squad for real matches, enter tournaments automatically, and earn
          Tournament Points (TP) when your players perform. Use TP to open packs
          and expand your squad for the next round.
        </motion.p>

        {/* CTA Button */}
        <motion.a
          href="https://pro.sport.fun/football"
          initial={{ opacity: 0, scale: 0.5 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ ...springAppear, delay: 0.4 }}
          className="mt-6 inline-flex items-center gap-2 px-7 py-3 rounded-full bg-[#121111] text-white font-medium text-[15px] hover:bg-[#121111]/90 transition-colors duration-200 shadow-[0_1px_2px_rgba(0,0,0,0.1),0_4px_12px_rgba(0,0,0,0.15)]"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="currentColor"
          >
            <path d="M8 5v14l11-7z" />
          </svg>
          Play Pro Now
        </motion.a>
      </div>
    </section>
  );
}
