import type { Metadata } from "next";
import type { ReactNode } from "react";
import { PwaRegister } from "@/components/pwa-register";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Receptionist",
  description: "سامانه منشی هوشمند چندمستاجری برای کسب‌وکارها",
  manifest: "/manifest.webmanifest",
  applicationName: "AI Receptionist",
  appleWebApp: {
    capable: true,
    title: "AI Receptionist",
    statusBarStyle: "default",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fa" dir="rtl">
      <body className="bg-slate-100 text-slate-900 antialiased">
        <a
          href="#main-content"
          className="sr-only z-50 rounded bg-white px-3 py-2 text-slate-900 focus:not-sr-only focus:fixed focus:right-3 focus:top-3"
        >
          رفتن به محتوای اصلی
        </a>
        <PwaRegister />
        {children}
      </body>
    </html>
  );
}
