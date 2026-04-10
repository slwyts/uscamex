"use client";

import { useState } from "react";
import Image from "next/image";
import Logo from "./Logo";
import { FadeUp, ScaleIn } from "./Animations";
import {
  XIcon,
  DiscordIcon,
  InstagramIcon,
  YouTubeIcon,
  TikTokIcon,
  LinkedInIcon,
} from "./SocialIcons";

const footerLinks = [
  { label: "Terms of Service", href: "/terms-of-service" },
  { label: "Cookie Policy", href: "/cookie-policy" },
  { label: "Legal Notice/Imprint", href: "/legal-notice" },
  { label: "Privacy Policy", href: "/privacy-policy" },
  {
    label: "MiCA Whitepaper",
    href: "https://docs.sport.fun/usdfun-token/mica-whitepaper",
    external: true,
  },
];

const socialLinks = [
  { icon: XIcon, href: "https://x.com/sportfun", label: "X" },
  {
    icon: DiscordIcon,
    href: "https://discord.gg/footballdotfun",
    label: "Discord",
  },
  {
    icon: InstagramIcon,
    href: "https://www.instagram.com/sportdotfun",
    label: "Instagram",
  },
  {
    icon: YouTubeIcon,
    href: "https://www.youtube.com/@sportdotfun",
    label: "YouTube",
  },
  {
    icon: TikTokIcon,
    href: "https://www.tiktok.com/@sportsdotfun",
    label: "TikTok",
  },
  {
    icon: LinkedInIcon,
    href: "https://www.linkedin.com/company/sportdotfun/",
    label: "LinkedIn",
  },
];

export default function FooterSection() {
  const [email, setEmail] = useState("");

  return (
    <section className="relative px-5 py-12 text-white">
      <div className="max-w-[1200px] mx-auto">
        <ScaleIn>
          <div className="rounded-[20px] overflow-hidden bg-[#0a0a0a] relative">
            {/* Background image with radial mask */}
            <div
              className="absolute inset-0 z-0"
              style={{
                mask: "radial-gradient(60% 92% at 50% 105.3%, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 95%)",
                WebkitMask:
                  "radial-gradient(60% 92% at 50% 105.3%, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 95%)",
              }}
            >
              <Image
                src="/images/footer-bg.jpg"
                alt=""
                fill sizes="100vw" priority
                className="object-cover"
              />
            </div>

            {/* Content */}
            <div className="relative z-10 pt-16 md:pt-24 px-6 md:px-12">
              {/* Newsletter */}
              <FadeUp className="text-center max-w-[520px] mx-auto">
                <h2 className="text-[24px] md:text-[36px] font-bold tracking-[-0.02em]">
                  Get exclusive updates, sent to your inbox.
                </h2>

                {/* Email form */}
                <div className="mt-8 relative">
                  <form
                    onSubmit={(e) => e.preventDefault()}
                    className="relative"
                  >
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="name@email.com"
                      className="w-full bg-[#121111]/75 border border-white/[0.06] rounded-xl py-3.5 pl-4 pr-[140px] text-[15px] text-white placeholder:text-white/40 outline-none focus:border-white/20 transition-colors font-[family-name:var(--font-inter)]"
                    />
                    <div className="absolute top-1 right-1 bottom-1">
                      <button
                        type="submit"
                        className="h-full px-6 rounded-lg bg-[#292929] text-white text-[15px] hover:bg-[#333] transition-colors duration-200 cursor-pointer border border-white/[0.04]"
                      >
                        Subscribe
                      </button>
                    </div>
                  </form>
                </div>
              </FadeUp>

              {/* Footer */}
              <footer className="mt-16 pt-8 border-t border-dashed border-white/[0.08]">
                <div className="flex flex-col lg:flex-row gap-8 pb-8">
                  {/* Navigation links */}
                  <nav className="flex flex-wrap gap-x-6 gap-y-3 flex-1">
                    {footerLinks.map((link) => (
                      <a
                        key={link.label}
                        href={link.href}
                        {...(link.external
                          ? { target: "_blank", rel: "noopener" }
                          : {})}
                        className="text-[13px] text-white/50 hover:text-white transition-colors duration-200"
                      >
                        {link.label}
                      </a>
                    ))}
                  </nav>

                  {/* Right column: social + legal */}
                  <div className="lg:border-l lg:border-dashed lg:border-white/[0.08] lg:pl-8 flex flex-col gap-6">
                    {/* Social */}
                    <div>
                      <p className="text-[13px] font-medium mb-3 text-white/70">
                        Follow Us
                      </p>
                      <div className="flex gap-2.5">
                        {socialLinks.map((social) => (
                          <a
                            key={social.label}
                            href={social.href}
                            target="_blank"
                            rel="noopener"
                            className="w-9 h-9 rounded-full bg-white/[0.06] flex items-center justify-center text-white/50 hover:text-white hover:bg-white/[0.12] transition-all duration-200"
                            aria-label={social.label}
                          >
                            <social.icon className="w-4 h-4" />
                          </a>
                        ))}
                      </div>
                    </div>

                    {/* Restricted jurisdictions */}
                    <p className="text-[11px] text-white/40 max-w-sm leading-[1.5]">
                      Residents of restricted jurisdictions are not eligible for
                      certain functionalities of the game.{" "}
                      <a
                        href="/restrictive-legend-for-website"
                        className="text-blue-400 hover:underline"
                      >
                        See full terms
                      </a>
                    </p>

                    {/* Logo + corp */}
                    <div className="flex items-center gap-4">
                      <Logo className="h-5 w-auto opacity-50" />
                    </div>
                    <p className="text-[11px] text-white/40">
                      Created by Sport.Fun Panama Corp
                    </p>
                  </div>
                </div>
              </footer>
            </div>
          </div>
        </ScaleIn>
      </div>
    </section>
  );
}
