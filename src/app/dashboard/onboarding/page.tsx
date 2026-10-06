"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/dashboard/auth";
import { LoadingState, PageHeader } from "@/components/dashboard/ui";

type State = {
  business: { name: string; phone: string | null; address: string | null };
  settings: {
    features?: { voice?: boolean; knowledge?: boolean; agent?: boolean };
    disclosure_message?: string;
    transfer?: { number?: string };
  };
  agents: Array<{ id: string; name: string; isActive: boolean; voiceId: string }>;
  knowledgeTotal: number;
};

export default function OnboardingPage() {
  const { apiJson } = useAuth();
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiJson<State["business"]>("/api/v1/business"),
      apiJson<{ settings: State["settings"] }>("/api/v1/business/settings"),
      apiJson<State["agents"]>("/api/v1/agents"),
      apiJson<{ pagination: { total: number } }>("/api/v1/knowledge?limit=1"),
    ]).then(([business, settings, agents, knowledge]) => {
      if (!cancelled) setState({ business, settings: settings.settings, agents, knowledgeTotal: knowledge.pagination.total });
    }).catch((err: Error) => {
      if (!cancelled) setError(err.message);
    });
    return () => { cancelled = true; };
  }, [apiJson]);

  if (!state && !error) return <LoadingState label="در حال بررسی آمادگی راه‌اندازی…" />;

  const activeAgent = state?.agents.find((agent) => agent.isActive);
  const checks = state ? [
    { label: "مشخصات کسب‌وکار", ok: Boolean(state.business.name && state.business.phone), href: "/dashboard/settings", help: "نام و شماره تماس را ثبت کنید." },
    { label: "نشانی و منطقه کاری", ok: Boolean(state.business.address), href: "/dashboard/settings", help: "نشانی کسب‌وکار را تکمیل کنید." },
    { label: "منشی فعال", ok: Boolean(activeAgent), href: "/dashboard/agent", help: "حداقل یک Agent فعال لازم است." },
    { label: "صدای منشی", ok: Boolean(activeAgent?.voiceId), href: "/dashboard/agent", help: "Voice ID را انتخاب و با Preview تست کنید." },
    { label: "پایگاه دانش", ok: state.knowledgeTotal > 0, href: "/dashboard/knowledge", help: "حداقل یک سند معتبر بارگذاری کنید." },
    { label: "اعلام ضبط تماس", ok: Boolean(state.settings.disclosure_message), href: "/dashboard/settings", help: "متن disclosure را تنظیم کنید." },
    { label: "مسیر انتقال به انسان", ok: Boolean(state.settings.transfer?.number), href: "/dashboard/settings", help: "شماره انتقال تماس را ثبت کنید." },
    { label: "قابلیت صوتی", ok: state.settings.features?.voice !== false, href: "/dashboard/settings", help: "Voice feature باید برای tenant فعال باشد." },
  ] : [];
  const complete = checks.filter((item) => item.ok).length;
  const percent = checks.length ? Math.round((complete / checks.length) * 100) : 0;

  return (
    <div>
      <PageHeader title="راه‌اندازی و Go-Live" desc="چک‌لیست واقعی قبل از اتصال شماره تلفن و پذیرش تماس" />
      {error ? <p role="alert" className="rounded-xl bg-rose-50 p-4 text-sm text-rose-700">{error}</p> : null}
      {state ? (
        <>
          <section className="rounded-2xl bg-white p-5 ring-1 ring-slate-200">
            <div className="flex items-center justify-between gap-3"><h2 className="font-semibold">آمادگی فضای کاری</h2><strong>{percent}%</strong></div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full bg-slate-900" style={{ width: `${percent}%` }} /></div>
            <p className="mt-2 text-xs text-slate-500">{complete} از {checks.length} کنترل آماده است. Providerهای واقعی (PSTN/STT/TTS) باید بعداً با credential واقعی acceptance شوند.</p>
          </section>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {checks.map((item) => (
              <Link key={item.label} href={item.href} className="rounded-2xl bg-white p-4 ring-1 ring-slate-200 hover:bg-slate-50">
                <div className="flex items-center justify-between gap-3"><h2 className="font-medium">{item.label}</h2><span aria-label={item.ok ? "آماده" : "نیازمند تکمیل"}>{item.ok ? "✓" : "!"}</span></div>
                <p className="mt-2 text-xs text-slate-500">{item.ok ? "آماده" : item.help}</p>
              </Link>
            ))}
          </div>
          <section className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm">
            <h2 className="font-semibold">Gate نهایی Go-Live</h2>
            <p className="mt-2 leading-7">Go-Live فقط بعد از تست تماس واقعی PSTN، مقایسه CDR، تست STT/TTS، webhook، انتقال به انسان و مشاهده usage/billing انجام شود. این صفحه موفقیت سرویس بیرونی را جعل نمی‌کند.</p>
          </section>
        </>
      ) : null}
    </div>
  );
}
