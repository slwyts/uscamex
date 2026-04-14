"use client";

import { useRef, useCallback } from "react";
import Image from "next/image";
import { motion, useSpring, useTransform, MotionValue } from "framer-motion";
import { FadeUp } from "./Animations";
import { useLocale } from "@/i18n/context";
import type { TranslationKey } from "@/i18n/locales";

interface CardItem {
  labelKey: TranslationKey;
  image: string;
  width: number;
  height: number;
  x: string;
  y: string;
  rotate: number;
  size: string;
  parallaxFactor: number;
}

const cards: CardItem[] = [
  {
    labelKey: "token.card1",
    image: "/images/card-hold-fun.png",
    width: 400,
    height: 400,
    x: "-38%",
    y: "-30%",
    rotate: -8,
    size: "220px",
    parallaxFactor: 1.2,
  },
  {
    labelKey: "token.card2",
    image: "/images/card-earn-points.png",
    width: 400,
    height: 400,
    x: "0%",
    y: "-35%",
    rotate: 3,
    size: "170px",
    parallaxFactor: 0.8,
  },
  {
    labelKey: "token.card3",
    image: "/images/card-rewards-pool.png",
    width: 400,
    height: 400,
    x: "35%",
    y: "-28%",
    rotate: 10,
    size: "240px",
    parallaxFactor: 1.0,
  },
  {
    labelKey: "token.card4",
    image: "/images/card-weekly-seasons.jpg",
    width: 400,
    height: 400,
    x: "-38%",
    y: "30%",
    rotate: -5,
    size: "220px",
    parallaxFactor: 1.1,
  },
  {
    labelKey: "token.card5",
    image: "/images/card-scouting.png",
    width: 400,
    height: 400,
    x: "0%",
    y: "35%",
    rotate: 2,
    size: "160px",
    parallaxFactor: 0.7,
  },
  {
    labelKey: "token.card6",
    image: "/images/card-tp-boosts.png",
    width: 400,
    height: 400,
    x: "38%",
    y: "28%",
    rotate: 8,
    size: "230px",
    parallaxFactor: 1.3,
  },
];

function FloatingCard({
  card,
  label,
  mouseX,
  mouseY,
}: {
  card: CardItem;
  label: string;
  mouseX: MotionValue<number>;
  mouseY: MotionValue<number>;
}) {
  const rotateX = useTransform(
    mouseY,
    [-0.5, 0.5],
    [12 * card.parallaxFactor, -12 * card.parallaxFactor]
  );
  const rotateY = useTransform(
    mouseX,
    [-0.5, 0.5],
    [-12 * card.parallaxFactor, 12 * card.parallaxFactor]
  );
  const translateX = useTransform(
    mouseX,
    [-0.5, 0.5],
    [-15 * card.parallaxFactor, 15 * card.parallaxFactor]
  );
  const translateY = useTransform(
    mouseY,
    [-0.5, 0.5],
    [-15 * card.parallaxFactor, 15 * card.parallaxFactor]
  );

  return (
    <motion.div
      className="absolute"
      style={{
        left: `calc(50% + ${card.x})`,
        top: `calc(50% + ${card.y})`,
        transform: `translate(-50%, -50%)`,
        width: card.size,
        perspective: "800px",
        zIndex: 1,
      }}
    >
      <motion.div
        style={{
          rotateX,
          rotateY,
          x: translateX,
          y: translateY,
          rotate: card.rotate,
          transformStyle: "preserve-3d",
        }}
        className="rounded-2xl overflow-hidden shadow-[0_8px_30px_rgba(0,0,0,0.3)] border border-white/[0.06]"
      >
        <Image
          src={card.image}
          alt={label}
          width={card.width}
          height={card.height}
          className="w-full h-auto"
        />
        <div className="absolute bottom-0 left-0 right-0 px-3 py-2 bg-gradient-to-t from-black/60 to-transparent">
          <span className="text-white text-[12px] font-medium drop-shadow-sm">
            {label}
          </span>
        </div>
      </motion.div>
    </motion.div>
  );
}

export default function FunTokenSection() {
  const sectionRef = useRef<HTMLDivElement>(null);
  const { t } = useLocale();

  const springConfig = { stiffness: 150, damping: 30 };
  const mouseXSpring = useSpring(0, springConfig);
  const mouseYSpring = useSpring(0, springConfig);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!sectionRef.current) return;
      const rect = sectionRef.current.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width - 0.5;
      const y = (e.clientY - rect.top) / rect.height - 0.5;
      mouseXSpring.set(x);
      mouseYSpring.set(y);
    },
    [mouseXSpring, mouseYSpring]
  );

  const handleMouseLeave = useCallback(() => {
    mouseXSpring.set(0);
    mouseYSpring.set(0);
  }, [mouseXSpring, mouseYSpring]);

  return (
    <section id="fan-tokens" className="relative px-5 py-20">
      <div className="max-w-[1200px] mx-auto">
        <div
          ref={sectionRef}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          className="relative min-h-[700px] md:min-h-[800px] flex flex-col items-center justify-center"
        >
          {/* Heading */}
          <FadeUp className="text-center relative z-10">
            <h2 className="text-[28px] md:text-[36px] lg:text-[48px] font-bold tracking-[-0.03em] leading-[1.15] gradient-text">
              {t("token.title1")}
              <br />
              {t("token.title2")}
            </h2>
          </FadeUp>

          {/* Description */}
          <FadeUp delay={0.1} className="text-center relative z-10 mt-6">
            <p className="text-white/45 text-[15px] max-w-[520px] mx-auto leading-[1.6]">
              {t("token.desc")}
            </p>
          </FadeUp>

          {/* CTA */}
          <FadeUp delay={0.2} className="relative z-10 mt-8">
            <a
              href="#buy"
              className="inline-flex items-center gap-2 px-8 py-3.5 rounded-full bg-[#f5c842] text-[#0a0a0f] font-bold text-[15px] hover:bg-[#f5c842]/90 transition-colors duration-200 shadow-[0_0_30px_rgba(245,200,66,0.25)]"
            >
              {t("token.cta")}
            </a>
          </FadeUp>

          {/* Floating 3D cards */}
          <div className="absolute inset-0 pointer-events-none hidden md:block">
            {cards.map((card) => (
              <FloatingCard
                key={card.labelKey}
                card={card}
                label={t(card.labelKey)}
                mouseX={mouseXSpring}
                mouseY={mouseYSpring}
              />
            ))}
          </div>

          {/* Mobile fallback: grid of cards */}
          <div className="md:hidden mt-10 grid grid-cols-2 gap-3">
            {cards.map((card) => (
              <div
                key={card.labelKey}
                className="rounded-2xl overflow-hidden shadow-md border border-white/[0.06]"
              >
                <Image
                  src={card.image}
                  alt={t(card.labelKey)}
                  width={card.width}
                  height={card.height}
                  className="w-full h-auto"
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
