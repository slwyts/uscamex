"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Link from "next/link";
import Logo from "./Logo";

const navLinks = [
  { label: "How to Play", href: "https://docs.sport.fun/" },
  { label: "Play for Free", href: "https://app.sport.fun/football" },
  { label: "Play Pro", href: "https://pro.sport.fun/football" },
];

export default function Navbar() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <motion.nav
      initial={{ opacity: 0, scale: 0.5 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ type: "spring", stiffness: 195, damping: 30, mass: 1 }}
      className="fixed top-4 left-1/2 -translate-x-1/2 z-50 w-[calc(100%-32px)] max-w-[1200px]"
    >
      <div className="flex items-center justify-between rounded-2xl border border-[#292b2b] bg-[#121111] backdrop-blur-xl px-5 py-3 shadow-[0_0.64px_0.64px_-0.94px_rgba(0,0,0,0.18),0_1.93px_1.93px_-1.88px_rgba(0,0,0,0.17),0_5.11px_5.11px_-2.81px_rgba(0,0,0,0.15),0_16px_16px_-3.75px_rgba(0,0,0,0.06)]">
        <Link href="/" className="flex-shrink-0">
          <Logo className="h-7 w-auto" />
        </Link>

        {/* Desktop nav */}
        <div className="hidden lg:flex items-center gap-1">
          {navLinks.map((link) => (
            <a
              key={link.label}
              href={link.href}
              rel="noopener"
              className="px-4 py-2 text-[15px] text-white/65 hover:text-white transition-colors duration-200"
            >
              {link.label}
            </a>
          ))}
        </div>

        <a
          href="https://opensea.io/token/base/0x16ee7ecac70d1028e7712751e2ee6ba808a7dd92/"
          target="_blank"
          rel="noopener"
          className="hidden lg:flex items-center px-5 py-2.5 rounded-full border border-[#292b2b] bg-[#292929] text-[15px] font-medium hover:bg-[#333] transition-colors duration-200 shadow-[inset_0px_-0.48px_0.48px_-1.25px_rgba(0,0,0,0.68),inset_0px_-1.83px_1.83px_-2.5px_rgba(0,0,0,0.6),inset_0px_-8px_8px_-3.75px_rgba(0,0,0,0.24)]"
        >
          Buy $FUN
        </a>

        {/* Mobile hamburger */}
        <button
          className="lg:hidden flex flex-col gap-1.5 p-2"
          onClick={() => setMobileOpen(!mobileOpen)}
          aria-label="Toggle menu"
        >
          <span
            className={`block w-5 h-0.5 bg-white transition-all duration-300 ${mobileOpen ? "rotate-45 translate-y-2" : ""}`}
          />
          <span
            className={`block w-5 h-0.5 bg-white transition-all duration-300 ${mobileOpen ? "opacity-0" : ""}`}
          />
          <span
            className={`block w-5 h-0.5 bg-white transition-all duration-300 ${mobileOpen ? "-rotate-45 -translate-y-2" : ""}`}
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
            className="lg:hidden mt-2 rounded-2xl border border-[#292b2b] bg-black/95 backdrop-blur-xl p-4 flex flex-col gap-1"
          >
            {navLinks.map((link) => (
              <a
                key={link.label}
                href={link.href}
                rel="noopener"
                className="px-4 py-3 text-[15px] text-white/65 hover:text-white hover:bg-white/5 rounded-xl transition-colors"
                onClick={() => setMobileOpen(false)}
              >
                {link.label}
              </a>
            ))}
            <a
              href="https://opensea.io/token/base/0x16ee7ecac70d1028e7712751e2ee6ba808a7dd92/"
              target="_blank"
              rel="noopener"
              className="mt-2 px-5 py-3 rounded-full border border-[#292b2b] bg-[#292929] text-[15px] font-medium text-center"
            >
              Buy $FUN
            </a>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.nav>
  );
}
