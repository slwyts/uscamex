"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Link from "next/link";
import Logo from "./Logo";
import { useLocale } from "@/i18n/context";

export default function Navbar() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { locale, setLocale, t } = useLocale();

  const navLinks = [
    { label: t("nav.predictions"), href: "#predictions" },
    { label: t("nav.fanTokens"), href: "#fan-tokens" },
    { label: t("nav.ecosystem"), href: "#ecosystem" },
    { label: t("nav.whitepaper"), href: "#whitepaper" },
  ];

  const toggleLocale = () => setLocale(locale === "zh" ? "en" : "zh");

  return (
    <motion.nav
      initial={{ opacity: 0, scale: 0.5 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ type: "spring", stiffness: 195, damping: 30, mass: 1 }}
      className="fixed top-4 left-1/2 -translate-x-1/2 z-50 w-[calc(100%-32px)] max-w-[1200px]"
    >
      <div className="flex items-center justify-between rounded-2xl border border-[#f5c842]/20 bg-[#0a0a0f]/90 backdrop-blur-xl px-5 py-3 shadow-[0_0.64px_0.64px_-0.94px_rgba(245,200,66,0.08),0_1.93px_1.93px_-1.88px_rgba(245,200,66,0.06),0_5.11px_5.11px_-2.81px_rgba(0,0,0,0.15),0_16px_16px_-3.75px_rgba(0,0,0,0.06)]">
        <Link href="/" className="flex-shrink-0">
          <Logo className="h-7 w-auto" />
        </Link>

        {/* Desktop nav */}
        <div className="hidden lg:flex items-center gap-1">
          {navLinks.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="px-4 py-2 text-[15px] text-white/65 hover:text-[#f5c842] transition-colors duration-200"
            >
              {link.label}
            </a>
          ))}
        </div>

        <div className="hidden lg:flex items-center gap-2">
          {/* Language toggle */}
          <button
            onClick={toggleLocale}
            className="px-3 py-2 rounded-full border border-white/[0.08] bg-white/[0.03] text-[13px] font-medium text-white/60 hover:text-[#f5c842] hover:border-[#f5c842]/20 transition-colors duration-200 cursor-pointer"
          >
            {locale === "zh" ? "EN" : "中"}
          </button>

          <a
            href="#buy"
            className="flex items-center px-5 py-2.5 rounded-full border border-[#f5c842]/30 bg-[#f5c842] text-[#0a0a0f] text-[15px] font-bold hover:bg-[#f5c842]/90 transition-colors duration-200 shadow-[0_0_20px_rgba(245,200,66,0.2)]"
          >
            {t("nav.buy")}
          </a>
        </div>

        {/* Mobile hamburger */}
        <button
          className="lg:hidden flex flex-col gap-1.5 p-2"
          onClick={() => setMobileOpen(!mobileOpen)}
          aria-label="Toggle menu"
        >
          <span
            className={`block w-5 h-0.5 bg-[#f5c842] transition-all duration-300 ${mobileOpen ? "rotate-45 translate-y-2" : ""}`}
          />
          <span
            className={`block w-5 h-0.5 bg-[#f5c842] transition-all duration-300 ${mobileOpen ? "opacity-0" : ""}`}
          />
          <span
            className={`block w-5 h-0.5 bg-[#f5c842] transition-all duration-300 ${mobileOpen ? "-rotate-45 -translate-y-2" : ""}`}
          />
        </button>
      </div>

      {/* Mobile menu */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
            className="lg:hidden mt-2 rounded-2xl border border-[#f5c842]/20 bg-[#0a0a0f]/95 backdrop-blur-xl p-4 flex flex-col gap-1"
          >
            {navLinks.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="px-4 py-3 text-[15px] text-white/65 hover:text-[#f5c842] hover:bg-white/5 rounded-xl transition-colors"
                onClick={() => setMobileOpen(false)}
              >
                {link.label}
              </a>
            ))}
            <div className="flex items-center gap-2 mt-2">
              <button
                onClick={toggleLocale}
                className="flex-1 px-5 py-3 rounded-full border border-white/[0.08] bg-white/[0.03] text-[15px] font-medium text-white/60 text-center cursor-pointer"
              >
                {locale === "zh" ? "English" : "中文"}
              </button>
              <a
                href="#buy"
                className="flex-1 px-5 py-3 rounded-full bg-[#f5c842] text-[#0a0a0f] text-[15px] font-bold text-center"
              >
                {t("nav.buy")}
              </a>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.nav>
  );
}
