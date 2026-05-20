import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { StarfieldBackground } from "@/components/StarfieldBackground";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ZER0 — autonomous Polymarket agent",
  description:
    "An autonomous AI watching Polymarket for deterministic-outcome trades. Watch its thoughts in real time.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="relative min-h-screen bg-black text-zinc-100">
        <StarfieldBackground />
        {children}
      </body>
    </html>
  );
}
