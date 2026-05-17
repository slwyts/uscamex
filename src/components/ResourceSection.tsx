"use client";

import { useEffect, useRef } from "react";
import Hls from "hls.js";
import { FadeUp, StaggerContainer, StaggerItem } from "./Animations";
import { useLocale } from "@/i18n/context";
import type { TranslationKey } from "@/i18n/locales";

const EXPLAINER_VIDEO_SRC = "/videos/uscamex-explainer.m3u8";

const resources: Array<{
  typeKey: TranslationKey;
  titleKey: TranslationKey;
  descKey: TranslationKey;
  size: string;
  href: string;
  kind: "document" | "video";
  actionKey: TranslationKey;
}> = [
  {
    typeKey: "resources.card.intro.type",
    titleKey: "resources.card.intro.title",
    descKey: "resources.card.intro.desc",
    size: "3.7 MB",
    href: "/resources/uscamex-project-intro.pdf",
    kind: "document",
    actionKey: "resources.card.openPdf",
  },
  {
    typeKey: "resources.card.video.type",
    titleKey: "resources.card.video.title",
    descKey: "resources.card.video.desc",
    size: "116 MB",
    href: "#resources",
    kind: "video",
    actionKey: "resources.card.openVideo",
  },
  {
    typeKey: "resources.card.whitepaper.type",
    titleKey: "resources.card.whitepaper.title",
    descKey: "resources.card.whitepaper.desc",
    size: "4.1 MB",
    href: "/whitepaper.pdf",
    kind: "document",
    actionKey: "resources.card.openPdf",
  },
];

export default function ResourceSection() {
  const { t } = useLocale();
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (Hls.isSupported()) {
      const hls = new Hls();
      hls.loadSource(EXPLAINER_VIDEO_SRC);
      hls.attachMedia(video);
      return () => hls.destroy();
    }

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = EXPLAINER_VIDEO_SRC;
    }
  }, []);

  const playExplainerVideo = () => {
    videoRef.current?.play().catch(() => undefined);
  };

  return (
    <section id="resources" className="relative px-5 py-20 md:py-28 text-white z-10">
      <div className="max-w-[1200px] mx-auto">
        <FadeUp className="max-w-[720px]">
          <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-[#f5c842]/30 bg-[#f5c842]/8 text-[12px] font-medium text-[#f5c842] tracking-wider uppercase">
            <span className="w-1.5 h-1.5 rounded-full bg-[#f5c842]" />
            {t("resources.badge")}
          </span>
          <h2 className="mt-5 text-[28px] md:text-[44px] font-bold tracking-[-0.02em] leading-[1.15] gradient-text">
            {t("resources.title")}
          </h2>
          <p className="mt-5 text-white/55 text-[15px] md:text-[16px] leading-[1.7]">
            {t("resources.desc")}
          </p>
        </FadeUp>

        <div className="mt-12 grid lg:grid-cols-[1.15fr_0.85fr] gap-6 lg:gap-8 items-start">
          <FadeUp>
            <div className="rounded-[20px] overflow-hidden border border-white/[0.08] bg-[#111118] shadow-[0_24px_80px_-36px_rgba(0,0,0,0.75)]">
              <div className="relative aspect-video bg-black">
                <video
                  ref={videoRef}
                  controls
                  playsInline
                  preload="metadata"
                  className="absolute inset-0 h-full w-full object-cover"
                />
              </div>
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 p-5 md:p-6 border-t border-white/[0.06]">
                <div>
                  <p className="text-[12px] uppercase tracking-wider text-[#f5c842]/70 font-semibold">
                    {t("resources.video.label")}
                  </p>
                  <h3 className="mt-1 text-[18px] md:text-[22px] font-bold text-white">
                    {t("resources.video.title")}
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={playExplainerVideo}
                  className="inline-flex items-center justify-center gap-2 rounded-full bg-[#f5c842] px-5 py-2.5 text-[14px] font-bold text-[#0a0a0f] hover:bg-[#f5c842]/90 transition-colors"
                >
                  <PlayIcon />
                  {t("resources.video.open")}
                </button>
              </div>
            </div>
          </FadeUp>

          <StaggerContainer className="grid gap-4">
            {resources.map((resource) => (
              <StaggerItem key={resource.href}>
                <a
                  href={resource.href}
                  {...(resource.href.startsWith("/")
                    ? { target: "_blank", rel: "noopener" }
                    : {})}
                  className="group flex gap-4 rounded-2xl border border-white/[0.08] bg-white/[0.035] p-5 transition-colors hover:border-[#f5c842]/35 hover:bg-white/[0.055]"
                >
                  <span className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl border border-[#f5c842]/20 bg-[#f5c842]/10 text-[#f5c842]">
                    {resource.kind === "video" ? <PlayIcon /> : <FileIcon />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2 text-[12px] font-semibold uppercase tracking-wider text-[#f5c842]/70">
                      {t(resource.typeKey)}
                      <span className="rounded-full border border-white/[0.08] px-2 py-0.5 text-[11px] text-white/35">
                        {resource.size}
                      </span>
                    </span>
                    <span className="mt-2 block text-[17px] font-bold text-white group-hover:text-[#f5c842] transition-colors">
                      {t(resource.titleKey)}
                    </span>
                    <span className="mt-2 block text-[13px] leading-[1.6] text-white/50">
                      {t(resource.descKey)}
                    </span>
                    <span className="mt-4 inline-flex items-center gap-2 text-[13px] font-bold text-white/75 group-hover:text-[#f5c842] transition-colors">
                      {t(resource.actionKey)}
                      <ArrowIcon />
                    </span>
                  </span>
                </a>
              </StaggerItem>
            ))}
          </StaggerContainer>
        </div>
      </div>
    </section>
  );
}

function FileIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M14 3v5a2 2 0 0 0 2 2h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6 3h8l7 7v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 14h8M8 17h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
