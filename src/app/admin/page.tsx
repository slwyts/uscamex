import type { Metadata } from "next";
import Link from "next/link";
import AdminDashboard from "@/components/admin/AdminDashboard";

export const metadata: Metadata = {
  title: "USCAMEX Admin",
  description: "USCAMEX 管理后台，面向项目方与运营使用。",
};

export default function AdminPage() {
  return (
    <main className="noise-overlay relative min-h-screen bg-[#0a0a0f]">
      <div className="bg-stripes" />
      <div className="relative z-10 border-b border-white/10 bg-black/30 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-[1380px] items-center justify-between px-4 py-4 md:px-8">
          <div>
            <div className="text-xs uppercase tracking-[0.22em] text-[#f5c842]">USCAMEX</div>
            <div className="mt-1 text-sm text-white/55">后台配置与运营控制台</div>
          </div>
          <Link
            href="/"
            className="rounded-full border border-white/10 px-4 py-2 text-sm text-white/75 transition hover:bg-white/5 hover:text-white"
          >
            返回官网
          </Link>
        </div>
      </div>
      <AdminDashboard />
    </main>
  );
}