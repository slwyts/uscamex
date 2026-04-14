"use client";

import { useState } from "react";
import Image from "next/image";
import Logo from "./Logo";
import { FadeUp, ScaleIn } from "./Animations";
import { XIcon, DiscordIcon } from "./SocialIcons";
import { useLocale } from "@/i18n/context";

function TelegramIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
    </svg>
  );
}

const socialLinks = [
  { icon: XIcon, href: "https://x.com/uscamex", label: "X" },
  { icon: DiscordIcon, href: "#", label: "Discord" },
  { icon: TelegramIcon, href: "#", label: "Telegram" },
];

const NODE_ADDRESS = "0x000000000000000000000000000000000000dEaD";

export default function FooterSection() {
  const [copied, setCopied] = useState(false);
  const { t } = useLocale();

  const handleCopy = () => {
    navigator.clipboard.writeText(NODE_ADDRESS);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const footerLinks = [
    { label: t("footer.terms"), href: "#" },
    { label: t("footer.privacy"), href: "#" },
    { label: t("footer.whitepaper"), href: "#whitepaper" },
    { label: t("footer.compliance"), href: "#" },
  ];

  return (
    <section className="relative px-5 py-12 text-white">
      <div className="max-w-[1200px] mx-auto">
        <ScaleIn>
          <div className="rounded-[20px] overflow-hidden bg-[#111118] relative">
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
                fill
                sizes="100vw"
                priority
                className="object-cover"
              />
            </div>

            {/* Content */}
            <div className="relative z-10 pt-16 md:pt-24 px-6 md:px-12">
              {/* Header + Genesis Node */}
              <FadeUp className="text-center max-w-[560px] mx-auto">
                <h2 className="text-[24px] md:text-[36px] font-bold tracking-[-0.02em] gradient-text">
                  {t("footer.title")}
                </h2>
                <p className="mt-4 text-white/45 text-[15px] leading-[1.7]">
                  {t("footer.desc")}
                </p>

                {/* Contract address */}
                <div className="mt-8 rounded-xl bg-[#0a0a0f] border border-white/[0.06] p-4">
                  <p className="text-[12px] text-white/40 mb-2">{t("footer.addressLabel")}</p>
                  <div className="flex items-center gap-3">
                    <code className="flex-1 text-[13px] md:text-[15px] text-[#f5c842] font-mono break-all text-left">
                      {NODE_ADDRESS}
                    </code>
                    <button
                      onClick={handleCopy}
                      className="flex-shrink-0 px-4 py-2 rounded-lg bg-[#f5c842] text-[#0a0a0f] text-[13px] font-bold hover:bg-[#f5c842]/90 transition-colors duration-200 cursor-pointer"
                    >
                      {copied ? t("footer.copied") : t("footer.copy")}
                    </button>
                  </div>
                </div>

                <p className="mt-4 text-[12px] text-white/30 leading-[1.6]">
                  {t("footer.addressNote")}
                </p>
              </FadeUp>

              {/* Footer */}
              <footer className="mt-16 pt-8 border-t border-dashed border-white/[0.06]">
                <div className="flex flex-col lg:flex-row gap-8 pb-8">
                  {/* Navigation links */}
                  <nav className="flex flex-wrap gap-x-6 gap-y-3 flex-1">
                    {footerLinks.map((link) => (
                      <a
                        key={link.label}
                        href={link.href}
                        className="text-[13px] text-white/40 hover:text-[#f5c842] transition-colors duration-200"
                      >
                        {link.label}
                      </a>
                    ))}
                  </nav>

                  {/* Right column: social + legal */}
                  <div className="lg:border-l lg:border-dashed lg:border-white/[0.06] lg:pl-8 flex flex-col gap-6">
                    {/* Social */}
                    <div>
                      <p className="text-[13px] font-medium mb-3 text-white/60">
                        {t("footer.followUs")}
                      </p>
                      <div className="flex gap-2.5">
                        {socialLinks.map((social) => (
                          <a
                            key={social.label}
                            href={social.href}
                            target="_blank"
                            rel="noopener"
                            className="w-9 h-9 rounded-full bg-white/[0.04] flex items-center justify-center text-white/40 hover:text-[#f5c842] hover:bg-[#f5c842]/10 transition-all duration-200"
                            aria-label={social.label}
                          >
                            <social.icon className="w-4 h-4" />
                          </a>
                        ))}
                      </div>
                    </div>

                    {/* Disclaimer */}
                    <p className="text-[11px] text-white/30 max-w-sm leading-[1.5]">
                      {t("footer.disclaimer")}
                    </p>

                    {/* Logo + corp */}
                    <div className="flex items-center gap-4">
                      <Logo className="h-5 w-auto opacity-40" />
                    </div>
                    <p className="text-[11px] text-white/30">
                      {t("footer.copyright")}
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
