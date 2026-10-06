"use client";

import { hasRole, type UserRole } from "@/lib/permissions";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useAuth } from "@/components/dashboard/auth";
import { useTenantBranding } from "@/components/dashboard/branding";
import { LoadingState } from "@/components/dashboard/ui";

const NAV: Array<{ href: string; label: string; roles?: Array<UserRole> }> = [
  { href: "/dashboard", label: "نمای کلی" },
  { href: "/dashboard/onboarding", label: "راه‌اندازی", roles: ["ADMIN", "MANAGER"] },
  { href: "/dashboard/calls", label: "تماس‌ها" },
  { href: "/dashboard/crm", label: "فرصت‌ها و پیگیری" },
  { href: "/dashboard/leads", label: "سرنخ‌ها" },
  { href: "/dashboard/customers", label: "مشتریان" },
  { href: "/dashboard/appointments", label: "نوبت‌ها" },
  { href: "/dashboard/knowledge", label: "پایگاه دانش" },
  { href: "/dashboard/agent", label: "منشی هوشمند" },
  { href: "/dashboard/quotas", label: "سهمیه‌ها", roles: ["ADMIN"] },
  { href: "/dashboard/billing", label: "صورتحساب", roles: ["ADMIN"] },
  { href: "/dashboard/platform-billing", label: "تطبیق پرداخت", roles: ["SUPER_ADMIN"] },
  { href: "/dashboard/quota-reservations", label: "بررسی رزرو سهمیه", roles: ["SUPER_ADMIN"] },
  { href: "/dashboard/usage", label: "مصرف" },
  { href: "/dashboard/users", label: "کاربران", roles: ["ADMIN", "MANAGER"] },
  { href: "/dashboard/automation", label: "اتوماسیون", roles: ["MANAGER"] },
  { href: "/dashboard/tenants", label: "مستأجرها", roles: ["SUPER_ADMIN"] },
  { href: "/dashboard/security", label: "امنیت حساب" },
  { href: "/dashboard/settings", label: "تنظیمات", roles: ["ADMIN"] },
];

export function DashboardShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, businessName, loading, logout } = useAuth();
  const { branding } = useTenantBranding();

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

  const visibleNav = NAV.filter((n) => !n.roles || n.roles.some((role) => hasRole(user.role, role)));

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-7xl gap-4 px-4 py-6 sm:px-6">
      <aside className="hidden w-56 shrink-0 md:block">
        <div className="sticky top-6 rounded-2xl p-4 text-white" style={{ backgroundColor: branding.accentColor }}>
          {branding.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- tenant-provided https logo, size unknown
            <img src={branding.logoUrl} alt={businessName ?? branding.productName} className="mb-2 h-8 max-w-full object-contain" />
          ) : null}
          <p className="truncate text-sm font-bold">{businessName ?? "داشبورد"}</p>
          {branding.hidePlatformBranding ? null : (
            <p className="mt-1 truncate text-[10px] text-white/60">{branding.productName}</p>
          )}
          <p className="mt-1 truncate text-xs text-slate-300">
            {user.name} — {user.role}
          </p>
          <nav className="mt-4 space-y-1" aria-label="ناوبری اصلی داشبورد">
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
        <nav className="mb-4 flex gap-2 overflow-x-auto md:hidden" aria-label="ناوبری موبایل">
          {visibleNav.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={`shrink-0 rounded-full px-3 py-1.5 text-xs ${pathname === n.href ? "bg-slate-900 text-white" : "bg-white text-slate-700 ring-1 ring-slate-200"}`}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <main id="main-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
