import type { Metadata } from "next";
import { Inter, Figtree } from "next/font/google";
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
  title: "Sport.Fun | Pick, Compete, Win.",
  description:
    "Sport.Fun is a skill-based sports competition platform. Build your squad for real matches, enter tournaments automatically, and earn Tournament Points.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${figtree.variable} antialiased`}
    >
      <body className="min-h-screen bg-[#f5f5f5] text-[#121111] font-[family-name:var(--font-figtree)]">
        {children}
      </body>
    </html>
  );
}
