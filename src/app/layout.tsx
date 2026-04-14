import type { Metadata } from "next";
import { Inter, Figtree } from "next/font/google";
import Providers from "@/components/Providers";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const figtree = Figtree({
  variable: "--font-figtree",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "USCAMEX | 美加墨预测市场 — 体育赛事预测经济平台",
  description:
    "USCAMEX（美加墨）是BNB链上首个预测经济平台，融合梦幻体育、预测市场和流动性交易，开创全新体育经济模式。引领体育进入Web3时代。",
  icons: {
    icon: "/favicon.svg",
    apple: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="zh"
      className={`${inter.variable} ${figtree.variable} antialiased`}
    >
      <body className="min-h-screen bg-[#0a0a0f] text-white font-[family-name:var(--font-figtree)]">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
