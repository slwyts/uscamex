import Navbar from "@/components/Navbar";
import Hero from "@/components/Hero";
import ArenaSection from "@/components/ArenaSection";
import RealDataSection from "@/components/RealDataSection";
import FunTokenSection from "@/components/FunTokenSection";
import FooterSection from "@/components/FooterSection";

export default function Home() {
  return (
    <main className="noise-overlay relative">
      {/* Vertical stripe lines */}
      <div className="bg-stripes" />
      <Navbar />
      <Hero />
      {/* Dark sections */}
      <div className="bg-[#121212] rounded-t-[32px]">
        <ArenaSection />
        <RealDataSection />
      </div>
      <FunTokenSection />
      <div className="bg-[#121212] rounded-t-[32px]">
        <FooterSection />
      </div>
    </main>
  );
}
