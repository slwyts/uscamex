import Navbar from "@/components/Navbar";
import Hero from "@/components/Hero";
import ArenaSection from "@/components/ArenaSection";
import RealDataSection from "@/components/RealDataSection";
import FunTokenSection from "@/components/FunTokenSection";
import FooterSection from "@/components/FooterSection";

export default function Home() {
  return (
    <main className="noise-overlay relative bg-[#0a0a0f]">
      {/* Vertical stripe lines */}
      <div className="bg-stripes" />
      <Navbar />
      <Hero />
      {/* Dark sections */}
      <div className="bg-[#0d0d14] rounded-t-[32px]">
        <ArenaSection />
        <RealDataSection />
      </div>
      <FunTokenSection />
      <div className="bg-[#0d0d14] rounded-t-[32px]">
        <FooterSection />
      </div>
    </main>
  );
}
