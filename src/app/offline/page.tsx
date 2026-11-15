export default function OfflinePage() {
  return (
    <main id="main-content" className="mx-auto flex min-h-screen max-w-xl items-center px-4">
      <section className="w-full rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-slate-200">
        <h1 className="text-xl font-bold">اتصال اینترنت در دسترس نیست</h1>
        <p className="mt-3 text-sm leading-7 text-slate-600">
          برای حفظ محرمانگی، داده‌های تماس، مشتری و داشبورد روی Service Worker ذخیره نمی‌شوند.
          پس از برقراری اتصال، صفحه را دوباره بارگذاری کنید.
        </p>
        <a href="/dashboard" className="mt-6 inline-block rounded-xl bg-slate-900 px-5 py-2 text-sm font-semibold text-white">
          تلاش مجدد
        </a>
      </section>
    </main>
  );
}
