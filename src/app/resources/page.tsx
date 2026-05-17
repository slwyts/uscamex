import type { Metadata } from "next";
import Navbar from "@/components/Navbar";
import ResourceSection from "@/components/ResourceSection";
import FooterSection from "@/components/FooterSection";

export const metadata: Metadata = {
  title: "资料库 | USCAMEX 美加墨",
  description: "USCAMEX 美加墨项目资料、官方白皮书与视频讲解资料库。",
};

export default function ResourcesPage() {
  return (
    <main className="noise-overlay relative min-h-screen bg-[#0a0a0f] pt-24">
      <div className="bg-stripes" />
      <Navbar />
      <ResourceSection />
      <div className="bg-[#0d0d14] rounded-t-[32px]">
        <FooterSection />
      </div>
    </main>
  );
}