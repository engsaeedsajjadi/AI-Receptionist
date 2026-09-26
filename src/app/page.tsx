import Link from "next/link";
import { db } from "@/db";
import { calls, leads, notifications, usageRecords } from "@/db/schema";
import { desc, eq, sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

async function getMetrics() {
  try {
    const [callStats] = await db
      .select({
        total: sql<number>`count(*)::int`,
        answered: sql<number>`count(*) filter (where ${calls.status} in ('ANSWERED','COMPLETED','TRANSFERRED'))::int`,
        missed: sql<number>`count(*) filter (where ${calls.status} = 'MISSED')::int`,
        avgDuration: sql<number>`coalesce(avg(${calls.durationSeconds}), 0)::int`,
      })
      .from(calls);

    const [leadStats] = await db
      .select({
        totalLeads: sql<number>`count(*)::int`,
        qualified: sql<number>`count(*) filter (where ${leads.status} in ('QUALIFIED','VISIT_REQUESTED','VISIT_SCHEDULED'))::int`,
      })
      .from(leads);

    const latestLeads = await db.select().from(leads).orderBy(desc(leads.createdAt)).limit(6);
    const latestNotifications = await db
      .select()
      .from(notifications)
      .orderBy(desc(notifications.createdAt))
      .limit(6);

    const usage = await db
      .select({ type: usageRecords.type, total: sql<string>`sum(${usageRecords.quantity})` })
      .from(usageRecords)
      .groupBy(usageRecords.type)
      .orderBy(desc(sql`sum(${usageRecords.quantity})`))
      .limit(5);

    return {
      ok: true,
      callStats,
      leadStats,
      latestLeads,
      latestNotifications,
      usage,
    } as const;
  } catch {
    return {
      ok: false,
      message: "جداول هنوز ایجاد نشده‌اند. ابتدا اسکیمای دیتابیس را اعمال کنید.",
    } as const;
  }
}

function Card({ title, value, sub }: { title: string; value: string | number; sub?: string }) {
  return (
    <article className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
      <p className="text-sm text-slate-500">{title}</p>
      <p className="mt-2 text-2xl font-bold text-slate-900">{value}</p>
      {sub ? <p className="mt-1 text-xs text-slate-500">{sub}</p> : null}
    </article>
  );
}

export default async function HomePage() {
  const metrics = await getMetrics();

  return (
    <main className="mx-auto min-h-screen w-full max-w-7xl px-4 py-8 sm:px-6">
      <header className="mb-8 rounded-2xl bg-slate-900 p-6 text-white">
        <h1 className="text-2xl font-bold">داشبورد منشی هوشمند املاک</h1>
        <p className="mt-2 text-sm text-slate-200">نسخه MVP: چندمستاجری، API نسخه‌بندی‌شده، مدیریت لید، تماس و دانش کسب‌وکار</p>
        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          {["ورودی تماس", "گفت‌وگوی فارسی", "ثبت لید", "انتقال به انسان", "گزارش مصرف"].map((pill) => (
            <span key={pill} className="rounded-full bg-white/10 px-3 py-1">
              {pill}
            </span>
          ))}
        </div>
      </header>

      {!metrics.ok ? (
        <section className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-amber-900">
          <p className="font-medium">{metrics.message}</p>
          <p className="mt-1 text-sm">پس از اجرای Drizzle push، این داشبورد داده‌ها را نمایش می‌دهد.</p>
        </section>
      ) : (
        <>
          <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card title="کل تماس‌های امروز/ثبت‌شده" value={metrics.callStats.total} />
            <Card title="تماس پاسخ‌داده‌شده" value={metrics.callStats.answered} />
            <Card title="تماس از دست رفته" value={metrics.callStats.missed} />
            <Card title="میانگین مدت تماس" value={`${metrics.callStats.avgDuration} ثانیه`} />
            <Card title="کل سرنخ‌ها" value={metrics.leadStats.totalLeads} />
            <Card title="سرنخ واجد شرایط" value={metrics.leadStats.qualified} />
          </section>

          <section className="mt-8 grid gap-4 lg:grid-cols-2">
            <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
              <h2 className="text-lg font-semibold">آخرین سرنخ‌ها</h2>
              <ul className="mt-4 space-y-3 text-sm">
                {metrics.latestLeads.length === 0 ? (
                  <li className="text-slate-500">هنوز لیدی ثبت نشده است.</li>
                ) : (
                  metrics.latestLeads.map((lead) => (
                    <li key={lead.id} className="rounded-xl bg-slate-50 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-medium">{lead.type}</span>
                        <span className="text-xs text-slate-500">{lead.status}</span>
                      </div>
                      <p className="mt-1 text-xs text-slate-500">{lead.location ?? "بدون منطقه"}</p>
                    </li>
                  ))
                )}
              </ul>
            </div>

            <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
              <h2 className="text-lg font-semibold">اعلان‌های اخیر</h2>
              <ul className="mt-4 space-y-3 text-sm">
                {metrics.latestNotifications.length === 0 ? (
                  <li className="text-slate-500">اعلانی ثبت نشده است.</li>
                ) : (
                  metrics.latestNotifications.map((n) => (
                    <li key={n.id} className="rounded-xl bg-slate-50 p-3">
                      <p className="font-medium">{n.title}</p>
                      <p className="mt-1 text-xs text-slate-500">{n.message}</p>
                    </li>
                  ))
                )}
              </ul>
            </div>
          </section>

          <section className="mt-8 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <h2 className="text-lg font-semibold">مصرف سرویس‌ها</h2>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {metrics.usage.length === 0 ? (
                <p className="text-sm text-slate-500">رکورد مصرفی وجود ندارد.</p>
              ) : (
                metrics.usage.map((u) => (
                  <div key={u.type} className="rounded-lg border border-slate-200 p-3 text-sm">
                    <p className="font-medium">{u.type}</p>
                    <p className="text-slate-600">{u.total}</p>
                  </div>
                ))
              )}
            </div>
          </section>
        </>
      )}

      <section className="mt-8 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <h2 className="text-lg font-semibold">API سریع</h2>
        <ul className="mt-3 grid gap-2 text-sm text-slate-700 sm:grid-cols-2">
          {[
            "POST /api/v1/auth/register",
            "POST /api/v1/auth/login",
            "GET /api/v1/leads",
            "GET /api/v1/calls",
            "POST /api/v1/knowledge/upload",
            "POST /api/v1/tools/properties/search",
          ].map((item) => (
            <li key={item} className="rounded-lg bg-slate-50 p-2 font-mono text-xs">
              {item}
            </li>
          ))}
        </ul>
        <p className="mt-4 text-xs text-slate-500">
          برای احراز هویت از هدر Authorization: Bearer {'<token>'} استفاده کنید.
        </p>
        <Link href="/api/health" className="mt-3 inline-block text-sm font-medium text-blue-700 hover:underline">
          بررسی سلامت سرویس
        </Link>
      </section>
    </main>
  );
}
