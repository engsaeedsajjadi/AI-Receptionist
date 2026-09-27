import Link from "next/link";

/**
 * Public landing page. Deliberately static — it must NEVER query tenant
 * data (calls, leads, usage) without authentication.
 */
export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col items-center justify-center px-4 py-12 sm:px-6">
      <header className="w-full rounded-2xl bg-slate-900 p-8 text-center text-white">
        <h1 className="text-3xl font-bold">منشی هوشمند تلفنی املاک</h1>
        <p className="mx-auto mt-3 max-w-2xl text-sm leading-7 text-slate-200">
          پاسخ‌گویی فارسی به تماس‌ها، جست‌وجوی فایل‌ها، ثبت سرنخ، نوبت بازدید و انتقال هوشمند به نیروی انسانی
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2 text-xs">
          {["ورودی تماس", "گفت‌وگوی فارسی", "ثبت لید", "انتقال به انسان", "گزارش مصرف"].map((pill) => (
            <span key={pill} className="rounded-full bg-white/10 px-3 py-1">
              {pill}
            </span>
          ))}
        </div>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/dashboard"
            className="rounded-xl bg-white px-6 py-2.5 text-sm font-semibold text-slate-900 hover:bg-slate-100"
          >
            ورود به داشبورد
          </Link>
          <Link
            href="/api/health"
            className="rounded-xl border border-white/20 px-6 py-2.5 text-sm font-medium text-white hover:bg-white/10"
          >
            بررسی سلامت سرویس
          </Link>
        </div>
      </header>

      <section className="mt-8 grid w-full gap-4 sm:grid-cols-3">
        {[
          { title: "پاسخ‌گویی فارسی", desc: "درک اعداد، قیمت و نشانی فارسی در مکالمه تلفنی" },
          { title: "مدیریت سرنخ", desc: "تشخیص مشتری تکراری و ثبت خودکار سرنخ" },
          { title: "نوبت و پیگیری", desc: "بررسی ظرفیت، ثبت نوبت بازدید و اعلان آنی" },
        ].map((f) => (
          <article key={f.title} className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <h2 className="font-semibold">{f.title}</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">{f.desc}</p>
          </article>
        ))}
      </section>
    </main>
  );
}
