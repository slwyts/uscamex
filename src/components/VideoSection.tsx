"use client";

import { useEffect, useRef } from "react";
import Hls from "hls.js";
import { useLocale } from "@/i18n/context";

export default function VideoSection() {
  const { t } = useLocale();
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const videoSrc = "/videos/main_video.m3u8";

    // 检查浏览器是否原生支持 m3u8 (例如 Safari)，否则使用 hls.js 解析播放
    if (Hls.isSupported()) {
      const hls = new Hls();
      hls.loadSource(videoSrc);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(e => console.error("Auto-play prevented", e));
      });
      return () => {
        hls.destroy();
      };
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = videoSrc;
      video.addEventListener('loadedmetadata', () => {
         video.play().catch(e => console.error("Auto-play prevented", e));
      });
    }
  }, []);

  return (
    <section className="relative w-full max-w-[1200px] mx-auto px-5 py-20 flex flex-col items-center z-10">
      <div className="w-full rounded-[24px] overflow-hidden border border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.5)] bg-[#111118]">
        <video 
          ref={videoRef}
          controls 
          muted 
          loop 
          playsInline 
          className="w-full h-auto object-cover"
        />
      </div>
    </section>
  );
}
