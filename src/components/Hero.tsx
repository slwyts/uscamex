"use client";

import { useRef, useEffect } from "react";
import Image from "next/image";
import { motion, useScroll, useTransform, useSpring, useMotionValue } from "framer-motion";

const springAppear = {
  type: "spring" as const,
  stiffness: 195,
  damping: 30,
  mass: 1,
};

export default function Hero() {
  const containerRef = useRef<HTMLDivElement>(null);
  
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
      {/* Background decorative radial mist at top matching the official nav shadow */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-[1200px] h-[500px] z-0 pointer-events-none">
        <div className="absolute top-0 left-0 w-full h-[300px] bg-[radial-gradient(ellipse_at_top,_rgba(0,0,0,0.35)_0%,_transparent_70%)] blur-2xl" />
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
              <div className="w-14 h-14 rounded-full bg-[#1a3a5c] border-[3px] border-white shadow-[0_8px_16px_rgba(0,0,0,0.1)] flex items-center justify-center text-white font-bold text-lg"><span className="opacity-80">12</span></div>
              <div className="w-14 h-14 rounded-full bg-[#c0392b] border-[3px] border-white shadow-[0_8px_16px_rgba(0,0,0,0.1)] flex items-center justify-center text-white font-bold text-lg -rotate-12"><span className="opacity-80">6</span></div>
              <div className="w-14 h-14 rounded-full bg-[#e0e0e0] border-[3px] border-white shadow-[0_8px_16px_rgba(0,0,0,0.1)] flex items-center justify-center text-[#121212] font-bold text-lg rotate-12"><span className="opacity-80">17</span></div>
            </motion.div>

            <motion.div 
              style={{ y: yParallaxReverse, x: useTransform(smoothMouseX, [-0.5, 0.5], [20, -20]) }}
              className="flex -space-x-4 ml-8"
            >
              <div className="w-12 h-12 rounded-full bg-[#8e44ad] border-[3px] border-white shadow-[0_8px_16px_rgba(0,0,0,0.1)] flex items-center justify-center text-white font-bold text-sm"><span className="opacity-80">10</span></div>
              <div className="w-12 h-12 rounded-full bg-[#2980b9] border-[3px] border-white shadow-[0_8px_16px_rgba(0,0,0,0.1)] flex items-center justify-center text-white font-bold text-sm rotate-12"><span className="opacity-80">47</span></div>
              <div className="w-12 h-12 rounded-full bg-[#34495e] border-[3px] border-white shadow-[0_8px_16px_rgba(0,0,0,0.1)] flex items-center justify-center text-white font-bold text-sm -rotate-6"><span className="opacity-80">4</span></div>
            </motion.div>

            <motion.div 
              style={{ y: yParallaxSlow, x: useTransform(smoothMouseX, [-0.5, 0.5], [-40, 40]) }}
              className="flex items-center gap-3 bg-white/90 backdrop-blur-md rounded-full px-5 py-2.5 shadow-[0_8px_24px_rgba(0,0,0,0.08)] border border-white -ml-12 rotate-[-5deg]"
            >
              <div className="w-8 h-8 rounded-full bg-[#121111] flex items-center justify-center text-white font-bold text-sm">TP</div>
              <span className="text-[20px] font-bold text-[#121111]/40 tracking-tight">
                12,269,420
              </span>
            </motion.div>
          </div>

          {/* Floating decorative elements RIGHT */}
          <div className="absolute -right-[200px] top-[15%] hidden lg:flex flex-col gap-12 items-end z-20 pointer-events-none">
            <motion.div 
              style={{ y: yParallaxReverse, x: useTransform(smoothMouseX, [-0.5, 0.5], [-20, 20]) }}
              className="flex items-center gap-3 bg-white/90 backdrop-blur-md rounded-full px-5 py-2.5 shadow-[0_8px_24px_rgba(0,0,0,0.08)] border border-white -mr-8 rotate-[5deg]"
            >
              <span className="text-[20px] font-bold text-[#121111]/40 tracking-tight">
                20,900
              </span>
              <span className="text-[16px] font-semibold text-[#121111]">
                $FUN
              </span>
            </motion.div>

            <motion.div 
              style={{ y: yParallaxSlow, x: useTransform(smoothMouseX, [-0.5, 0.5], [40, -40]) }}
              className="flex -space-x-4 mr-6"
            >
              <div className="w-14 h-14 rounded-full bg-[#34495e] border-[3px] border-white shadow-[0_8px_16px_rgba(0,0,0,0.1)] flex items-center justify-center text-white font-bold text-lg"><span className="opacity-80">88</span></div>
              <div className="w-14 h-14 rounded-full bg-[#1abc9c] border-[3px] border-white shadow-[0_8px_16px_rgba(0,0,0,0.1)] flex items-center justify-center text-white font-bold text-lg -rotate-12"><span className="opacity-80">1</span></div>
              <div className="w-14 h-14 rounded-full bg-[#e74c3c] border-[3px] border-white shadow-[0_8px_16px_rgba(0,0,0,0.1)] flex items-center justify-center text-white font-bold text-lg rotate-12"><span className="opacity-80">8</span></div>
            </motion.div>

            <motion.div 
              style={{ y: yParallaxFast, x: useTransform(smoothMouseX, [-0.5, 0.5], [30, -30]) }}
              className="flex -space-x-4"
            >
              <div className="w-12 h-12 rounded-full bg-[#2ecc71] border-[3px] border-white shadow-[0_8px_16px_rgba(0,0,0,0.1)] flex items-center justify-center text-white font-bold text-sm rotate-6"><span className="opacity-80">0</span></div>
              <div className="w-12 h-12 rounded-full bg-[#3498db] border-[3px] border-white shadow-[0_8px_16px_rgba(0,0,0,0.1)] flex items-center justify-center text-white font-bold text-sm"><span className="opacity-80">9</span></div>
              <div className="w-12 h-12 rounded-full bg-[#121111] border-[3px] border-white shadow-[0_8px_16px_rgba(0,0,0,0.1)] flex items-center justify-center text-white font-bold text-sm -rotate-6"><span className="opacity-80">89</span></div>
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
              alt="Sport.Fun app"
              width={975}
              height={2220}
              className="w-full h-auto drop-shadow-[0_20px_60px_rgba(0,0,0,0.15)]"
              priority
            />
          </motion.div>
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
