"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useAuth } from "@/components/dashboard/auth";
import { LoadingState } from "@/components/dashboard/ui";

const NAV: Array<{ href: string; label: string; roles?: Array<"ADMIN" | "MANAGER" | "AGENT"> }> = [
  { href: "/dashboard", label: "نمای کلی" },
  { href: "/dashboard/calls", label: "تماس‌ها" },
  { href: "/dashboard/leads", label: "سرنخ‌ها" },
  { href: "/dashboard/customers", label: "مشتریان" },
  { href: "/dashboard/appointments", label: "نوبت‌ها" },
  { href: "/dashboard/knowledge", label: "پایگاه دانش" },
  { href: "/dashboard/agents", label: "AI Agent Studio" },
  { href: "/dashboard/billing", label: "صورتحساب", roles: ["ADMIN", "MANAGER"] },
  { href: "/dashboard/usage", label: "مصرف" },
  { href: "/dashboard/users", label: "کاربران", roles: ["ADMIN", "MANAGER"] },
  { href: "/dashboard/settings", label: "تنظیمات", roles: ["ADMIN"] },
];

export function DashboardShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, businessName, loading, logout } = useAuth();

  const isLoginPage = pathname === "/dashboard/login";

  useEffect(() => {
    if (!loading && !user && !isLoginPage) {
      router.replace("/dashboard/login");
    }
  }, [loading, user, isLoginPage, router]);

  if (isLoginPage) {
    return <>{children}</>;
  }

  if (loading) {
    return (
      <main className="mx-auto max-w-7xl px-4 py-8">
        <LoadingState label="در حال بررسی نشست…" />
      </main>
    );
  }

  if (!user) return null;

  const visibleNav = NAV.filter((n) => !n.roles || n.roles.includes(user.role));

  return (
    <div className="flex min-h-screen w-full gap-4 bg-slate-50 px-3 py-3 sm:px-4">
      <aside className="hidden w-64 shrink-0 md:block">
        <div className="sticky top-3 min-h-[calc(100vh-1.5rem)] rounded-2xl bg-slate-950 p-4 text-white shadow-xl">
          <p className="truncate text-sm font-bold">{businessName ?? "داشبورد"}</p>
          <p className="mt-1 truncate text-xs text-slate-300">
            {user.name} — {user.role}
          </p>
          <nav className="mt-4 space-y-1">
            {visibleNav.map((n) => {
              const active = pathname === n.href;
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  className={`block rounded-lg px-3 py-2 text-sm ${active ? "bg-white/15 font-semibold" : "text-slate-200 hover:bg-white/10"}`}
                >
                  {n.label}
                </Link>
              );
            })}
          </nav>
          <button
            onClick={() => {
              void logout().then(() => router.replace("/dashboard/login"));
            }}
            className="mt-4 w-full rounded-lg border border-white/20 px-3 py-2 text-sm hover:bg-white/10"
          >
            خروج
          </button>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <div className="mb-4 flex gap-2 overflow-x-auto md:hidden">
          {visibleNav.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={`shrink-0 rounded-full px-3 py-1.5 text-xs ${pathname === n.href ? "bg-slate-900 text-white" : "bg-white text-slate-700 ring-1 ring-slate-200"}`}
            >
              {n.label}
            </Link>
          ))}
        </div>
        {children}
      </div>
    </div>
  );
}
