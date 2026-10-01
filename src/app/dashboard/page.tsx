"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/dashboard/auth";
import { Card, EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/dashboard/ui";

type CountResponse = { pagination: { total: number } };
type UsageResponse = { totals: Array<{ type: string; total: string }>; estimatedCostUsd: string };

export default function OverviewPage() {
  const { apiJson } = useAuth();
  const [stats, setStats] = useState<{ calls: number; leads: number; customers: number; usage: UsageResponse | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiJson<CountResponse>("/api/v1/calls?limit=1"),
      apiJson<CountResponse>("/api/v1/leads?limit=1"),
      apiJson<CountResponse>("/api/v1/customers?limit=1"),
      apiJson<UsageResponse>("/api/v1/usage?limit=1"),
    ])
      .then(([calls, leads, customers, usage]) => {
        if (!cancelled) {
          setStats({ calls: calls.pagination.total, leads: leads.pagination.total, customers: customers.pagination.total, usage });
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [apiJson]);

  return (
    <div>
      <PageHeader title="داشبورد مدیریتی" desc="نمای زنده تماس‌ها، CRM، مشتریان و مصرف AI" />
      {error ? (
        <ErrorState message={error} onRetry={() => window.location.reload()} />
      ) : !stats ? (
        <LoadingState />
      ) : (
        <>
          <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card title="کل تماس‌ها" value={stats.calls} />
            <Card title="کل سرنخ‌ها" value={stats.leads} />
            <Card title="مشتریان" value={stats.customers} />
            <Card title="هزینه تقریبی (دلار)" value={Number(stats.usage?.estimatedCostUsd ?? 0).toFixed(4)} sub="بر اساس جدول قیمت‌گذاری" />
          </section>
          <section className="mt-6 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <h2 className="font-semibold">مصرف سرویس‌ها</h2>
            {!stats.usage || stats.usage.totals.length === 0 ? (
              <div className="mt-3">
                <EmptyState label="رکورد مصرفی ثبت نشده است." />
              </div>
            ) : (
              <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {stats.usage.totals.map((t) => (
                  <div key={t.type} className="rounded-lg border border-slate-200 p-3 text-sm">
                    <p className="font-medium" dir="ltr">
                      {t.type}
                    </p>
                    <p className="text-slate-600">{t.total}</p>
                  </div>
                ))}
              </div>
            )}
          </section>
          <section className="mt-6 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { href: "/dashboard/voice", label: "Voice Console" },
              { href: "/dashboard/crm", label: "CRM Pipeline" },
              { href: "/dashboard/agents", label: "AI Agent Studio" },
              { href: "/dashboard/calls", label: "مشاهده تماس‌ها" },
              { href: "/dashboard/leads", label: "مشاهده سرنخ‌ها" },
              { href: "/dashboard/knowledge", label: "مدیریت پایگاه دانش" },
            ].map((l) => (
              <Link key={l.href} href={l.href} className="rounded-xl bg-white p-4 text-center text-sm font-medium shadow-sm ring-1 ring-slate-200 hover:bg-slate-50">
                {l.label}
              </Link>
            ))}
          </section>
        </>
      )}
    </div>
  );
}
