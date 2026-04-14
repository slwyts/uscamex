"use client";

import { useRef } from "react";
import Image from "next/image";
import { motion, useScroll, useTransform, useSpring, useMotionValue } from "framer-motion";
import { useLocale } from "@/i18n/context";

const springAppear = {
  type: "spring" as const,
  stiffness: 195,
  damping: 30,
  mass: 1,
};

export default function Hero() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { t } = useLocale();

  // Scroll Parallax
  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ["start start", "end start"],
  });

  const yParallaxFast = useTransform(scrollYProgress, [0, 1], [0, -150]);
  const yParallaxSlow = useTransform(scrollYProgress, [0, 1], [0, -80]);
  const yParallaxReverse = useTransform(scrollYProgress, [0, 1], [0, 100]);

  // Mouse Parallax
  const mouseX = useMotionValue(0);
  const mouseY = useMotionValue(0);

  const springConfig = { stiffness: 75, damping: 20 };
  const smoothMouseX = useSpring(mouseX, springConfig);
  const smoothMouseY = useSpring(mouseY, springConfig);

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!containerRef.current) return;
    const { left, top, width, height } = containerRef.current.getBoundingClientRect();
    const x = (e.clientX - left) / width - 0.5;
    const y = (e.clientY - top) / height - 0.5;
    mouseX.set(x);
    mouseY.set(y);
  };

  const handleMouseLeave = () => {
    mouseX.set(0);
    mouseY.set(0);
  };

  return (
    <section
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      className="relative flex flex-col items-center overflow-hidden pt-28 pb-20"
    >
      {/* Background image */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-[1200px] h-[500px] z-0 pointer-events-none">
        <Image
          src="/images/hero-bg.png"
          alt=""
          fill
          sizes="100vw"
          className="object-cover object-top opacity-40"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-[#0a0a0f]/60 to-[#0a0a0f]" />
      </div>

      <div className="relative z-10 flex flex-col items-center text-center max-w-4xl mx-auto px-5">
        {/* Badge */}
        <motion.div
          initial={{ opacity: 0, scale: 0.5 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ ...springAppear, delay: 0.05 }}
          className="mb-6 inline-flex items-center gap-2 px-4 py-2 rounded-full border border-[#f5c842]/20 bg-[#f5c842]/5 backdrop-blur-sm"
        >
          <span className="w-2 h-2 rounded-full bg-[#10b981] pulse-glow" />
          <span className="text-[13px] text-[#f5c842]/80 font-medium">{t("hero.badge")}</span>
        </motion.div>

        {/* Heading */}
        <motion.h1
          initial={{ opacity: 0, scale: 0.5 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ ...springAppear, delay: 0.1 }}
          className="text-[52px] md:text-[72px] lg:text-[96px] font-bold tracking-[-0.04em] leading-[1.05] gradient-text"
        >
          {t("hero.title1")}
          <br />
          {t("hero.title2")}
          <br />
          {t("hero.title3")}
        </motion.h1>

        {/* Phone & Floating elements container */}
        <motion.div
          initial={{ opacity: 0, scale: 0.5 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ ...springAppear, delay: 0.2 }}
          className="relative mt-10 w-full max-w-[320px] md:max-w-[380px]"
        >
          {/* Floating decorative elements LEFT */}
          <div className="absolute -left-[200px] top-[10%] hidden lg:flex flex-col gap-12 z-20 pointer-events-none">
            <motion.div
              style={{ y: yParallaxFast, x: useTransform(smoothMouseX, [-0.5, 0.5], [-30, 30]) }}
              className="flex -space-x-4"
            >
              <div className="w-14 h-14 rounded-full bg-[#3C3B6E] border-[3px] border-[#1a1a24] shadow-[0_8px_16px_rgba(0,0,0,0.3)] flex items-center justify-center text-white font-bold text-lg"><span className="opacity-80">🇺🇸</span></div>
              <div className="w-14 h-14 rounded-full bg-[#FF0000] border-[3px] border-[#1a1a24] shadow-[0_8px_16px_rgba(0,0,0,0.3)] flex items-center justify-center text-white font-bold text-lg -rotate-12"><span className="opacity-80">🇨🇦</span></div>
              <div className="w-14 h-14 rounded-full bg-[#006847] border-[3px] border-[#1a1a24] shadow-[0_8px_16px_rgba(0,0,0,0.3)] flex items-center justify-center text-white font-bold text-lg rotate-12"><span className="opacity-80">🇲🇽</span></div>
            </motion.div>

            <motion.div
              style={{ y: yParallaxReverse, x: useTransform(smoothMouseX, [-0.5, 0.5], [20, -20]) }}
              className="flex -space-x-4 ml-8"
            >
              <div className="w-12 h-12 rounded-full bg-[#009c3b] border-[3px] border-[#1a1a24] shadow-[0_8px_16px_rgba(0,0,0,0.3)] flex items-center justify-center text-white font-bold text-sm"><span className="opacity-80">🇧🇷</span></div>
              <div className="w-12 h-12 rounded-full bg-[#75AADB] border-[3px] border-[#1a1a24] shadow-[0_8px_16px_rgba(0,0,0,0.3)] flex items-center justify-center text-white font-bold text-sm rotate-12"><span className="opacity-80">🇦🇷</span></div>
              <div className="w-12 h-12 rounded-full bg-[#002395] border-[3px] border-[#1a1a24] shadow-[0_8px_16px_rgba(0,0,0,0.3)] flex items-center justify-center text-white font-bold text-sm -rotate-6"><span className="opacity-80">🇫🇷</span></div>
            </motion.div>

            <motion.div
              style={{ y: yParallaxSlow, x: useTransform(smoothMouseX, [-0.5, 0.5], [-40, 40]) }}
              className="flex items-center gap-3 bg-[#111118]/90 backdrop-blur-md rounded-full px-5 py-2.5 shadow-[0_8px_24px_rgba(0,0,0,0.2)] border border-[#f5c842]/10 -ml-12 rotate-[-5deg]"
            >
              <div className="w-8 h-8 rounded-full bg-[#f5c842] flex items-center justify-center text-[#0a0a0f] font-bold text-sm">$</div>
              <span className="text-[20px] font-bold text-[#f5c842]/50 tracking-tight">
                12,269,420
              </span>
            </motion.div>
          </div>

          {/* Floating decorative elements RIGHT */}
          <div className="absolute -right-[200px] top-[15%] hidden lg:flex flex-col gap-12 items-end z-20 pointer-events-none">
            <motion.div
              style={{ y: yParallaxReverse, x: useTransform(smoothMouseX, [-0.5, 0.5], [-20, 20]) }}
              className="flex items-center gap-3 bg-[#111118]/90 backdrop-blur-md rounded-full px-5 py-2.5 shadow-[0_8px_24px_rgba(0,0,0,0.2)] border border-[#10b981]/10 -mr-8 rotate-[5deg]"
            >
              <span className="text-[20px] font-bold text-[#10b981]/50 tracking-tight">
                +420%
              </span>
              <span className="text-[16px] font-semibold text-white/80">
                $USCAMEX
              </span>
            </motion.div>

            <motion.div
              style={{ y: yParallaxSlow, x: useTransform(smoothMouseX, [-0.5, 0.5], [40, -40]) }}
              className="flex -space-x-4 mr-6"
            >
              <div className="w-14 h-14 rounded-full bg-[#CF081F] border-[3px] border-[#1a1a24] shadow-[0_8px_16px_rgba(0,0,0,0.3)] flex items-center justify-center text-white font-bold text-lg"><span className="opacity-80">🇬🇧</span></div>
              <div className="w-14 h-14 rounded-full bg-[#000000] border-[3px] border-[#1a1a24] shadow-[0_8px_16px_rgba(0,0,0,0.3)] flex items-center justify-center text-white font-bold text-lg -rotate-12"><span className="opacity-80">🇩🇪</span></div>
              <div className="w-14 h-14 rounded-full bg-[#e74c3c] border-[3px] border-[#1a1a24] shadow-[0_8px_16px_rgba(0,0,0,0.3)] flex items-center justify-center text-white font-bold text-lg rotate-12"><span className="opacity-80">🇪🇸</span></div>
            </motion.div>

            <motion.div
              style={{ y: yParallaxFast, x: useTransform(smoothMouseX, [-0.5, 0.5], [30, -30]) }}
              className="flex -space-x-4"
            >
              <div className="w-12 h-12 rounded-full bg-[#1abc9c] border-[3px] border-[#1a1a24] shadow-[0_8px_16px_rgba(0,0,0,0.3)] flex items-center justify-center text-white font-bold text-sm rotate-6"><span className="opacity-80">🇵🇹</span></div>
              <div className="w-12 h-12 rounded-full bg-[#3498db] border-[3px] border-[#1a1a24] shadow-[0_8px_16px_rgba(0,0,0,0.3)] flex items-center justify-center text-white font-bold text-sm"><span className="opacity-80">🇯🇵</span></div>
              <div className="w-12 h-12 rounded-full bg-[#f5c842] border-[3px] border-[#1a1a24] shadow-[0_8px_16px_rgba(0,0,0,0.3)] flex items-center justify-center text-[#0a0a0f] font-bold text-sm -rotate-6"><span className="opacity-80">🇰🇷</span></div>
            </motion.div>
          </div>

          <motion.div
            style={{
              rotateX: useTransform(smoothMouseY, [-0.5, 0.5], [10, -10]),
              rotateY: useTransform(smoothMouseX, [-0.5, 0.5], [-10, 10]),
              transformStyle: "preserve-3d",
              perspective: 1200
            }}
          >
            <Image
              src="/images/hero-phone.png"
              alt="USCAMEX 预测市场"
              width={975}
              height={2220}
              className="w-full h-auto drop-shadow-[0_20px_60px_rgba(245,200,66,0.1)]"
              priority
            />
          </motion.div>
        </motion.div>

        {/* Description */}
        <motion.p
          initial={{ opacity: 0, scale: 0.5 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ ...springAppear, delay: 0.3 }}
          className="mt-10 text-[15px] md:text-[17px] text-white/45 max-w-[620px] leading-[1.7]"
        >
          {t("hero.desc")}
        </motion.p>

        {/* CTA Buttons */}
        <motion.div
          initial={{ opacity: 0, scale: 0.5 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ ...springAppear, delay: 0.4 }}
          className="mt-8 flex flex-col sm:flex-row items-center gap-4"
        >
          <a
            href="#predictions"
            className="inline-flex items-center gap-2 px-8 py-3.5 rounded-full bg-[#f5c842] text-[#0a0a0f] font-bold text-[15px] hover:bg-[#f5c842]/90 transition-colors duration-200 shadow-[0_0_30px_rgba(245,200,66,0.25)]"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path d="M8 5v14l11-7z" />
            </svg>
            {t("hero.cta")}
          </a>
          <a
            href="#buy"
            className="inline-flex items-center gap-2 px-8 py-3.5 rounded-full border border-white/[0.1] bg-white/[0.03] text-white font-medium text-[15px] hover:bg-white/[0.06] transition-colors duration-200"
          >
            {t("hero.ctaBuy")}
          </a>
        </motion.div>
      </div>
    </section>
  );
}
