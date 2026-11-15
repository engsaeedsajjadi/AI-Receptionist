"use client";
import { useState } from "react";
import { useAuth } from "@/components/dashboard/auth";

type Reservation = { id: string; businessId: string; createdAt: string; status: string; amounts: Record<string, string>; windows: Record<string, string> };
type Page = { data: Reservation[]; hasMore: boolean; nextCursor: string | null };
export default function ReservationReconciliationPage() {
  const { apiJson, user } = useAuth();
  const [businessId, setBusinessId] = useState("");
  const [loadedBusiness, setLoadedBusiness] = useState("");
  const [page, setPage] = useState<Page | null>(null);
  const [selected, setSelected] = useState<Reservation | null>(null);
  const [action, setAction] = useState("settle");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function load(target: string, after?: string) {
    const query = new URLSearchParams({ businessId: target, ...(after ? { after } : {}) });
    const result = await apiJson<Page>(`/api/v1/platform/quota-reservations?${query}`);
    setPage(result); setLoadedBusiness(target); setSelected(null);
  }
  async function perform(task: () => Promise<void>) {
    setBusy(true); setMessage("");
    try { await task(); } catch (error) { setMessage(error instanceof Error ? error.message : "عملیات ناموفق بود"); }
    finally { setBusy(false); }
  }
  if (user?.role !== "SUPER_ADMIN") return <p>این صفحه ویژهٔ مدیر سراسری دارای MFA است.</p>;
  return <section className="space-y-5">
    <h1 className="text-2xl font-bold">بررسی رزروهای بلاتکلیف سهمیه</h1>
    <p>رزروهای باز با عمر حداقل ۱۵ دقیقه نمایش داده می‌شوند. ابتدا در سرویس‌دهنده بررسی کنید اجرای عملیات پایان یافته است. گذشت زمان به‌تنهایی مجوز آزادسازی سهمیه نیست.</p>
    <p role="status" aria-live="polite">{message}</p>
    <form className="space-y-3" onSubmit={e => { e.preventDefault(); void perform(() => load(businessId.trim())); }}>
      <label className="block">شناسهٔ مستأجر<input className="block w-full rounded border p-2" dir="ltr" value={businessId} onChange={e => setBusinessId(e.target.value)} required /></label>
      <button className="rounded border p-2" disabled={busy}>نمایش رزروها</button>
    </form>
    {page && <><div className="overflow-x-auto"><table className="w-full text-right"><caption>رزروهای مستأجر {loadedBusiness}</caption>
      <thead><tr>{["شناسه", "زمان ایجاد", "مقدار رزرو", "دورهٔ اصلی", "عملیات"].map(label => <th key={label} className="p-2">{label}</th>)}</tr></thead>
      <tbody>{page.data.map(row => <tr key={row.id} className="border-t"><td dir="ltr" className="p-2">{row.id}</td><td>{new Date(row.createdAt).toLocaleString("fa-IR")}</td>
        <td><pre dir="ltr">{JSON.stringify(row.amounts, null, 2)}</pre></td><td><pre dir="ltr">{JSON.stringify(row.windows, null, 2)}</pre></td>
        <td><button disabled={busy} className="rounded border p-2" onClick={() => { setSelected(row); setAction("settle"); }}>بررسی</button></td></tr>)}</tbody>
    </table></div>{!page.data.length && <p>رزرو بازی مطابق این فیلتر وجود ندارد.</p>}
      {page.hasMore && <button disabled={busy} className="rounded border p-2" onClick={() => void perform(() => load(loadedBusiness, page.nextCursor!))}>صفحهٔ بعد</button>}</>}
    {selected && <form key={selected.id} className="space-y-3 rounded border p-4" onSubmit={e => {
      e.preventDefault(); const data = new FormData(e.currentTarget); const reservation = selected;
      void perform(async () => {
        const body = { id: reservation.id, businessId: reservation.businessId, action,
          reason: data.get("reason"), evidenceReference: data.get("evidenceReference"), executionStopped: data.get("stopped") === "on",
          ...(action === "settle" ? { actual: Object.fromEntries(Object.keys(reservation.amounts).map(meter => [meter, Number(data.get(meter))])) } : { noUsageConfirmed: data.get("noUsage") === "on" }),
        };
        const result = await apiJson<{ changed: boolean; overrun: boolean }>("/api/v1/platform/quota-reservations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        setSelected(null);
        setPage(current => current ? { ...current, data: current.data.filter(row => row.id !== reservation.id) } : null);
        setMessage(!result.changed ? "این نتیجه قبلاً ثبت شده است." : result.overrun ? "مصرف بیش از رزرو ثبت شد و در سابقهٔ حسابرسی باقی ماند." : "تعیین تکلیف رزرو و سابقهٔ حسابرسی ثبت شد.");
      });
    }}>
      <h2 className="font-bold">تعیین تکلیف رزرو {selected.id}</h2>
      <label className="block">نتیجه<select className="block rounded border p-2" value={action} onChange={e => setAction(e.target.value)} disabled={busy}>
        <option value="settle">ثبت مصرف تأییدشده</option><option value="release">آزادسازی — عدم مصرف تأیید شده</option></select></label>
      {action === "settle" ? Object.keys(selected.amounts).map(meter => <label key={meter} className="block">مصرف واقعی {meter}<input name={meter} type="number" min="0" max="100000000000" step="0.0001" required className="block rounded border p-2" /></label>) :
        <label className="block"><input type="checkbox" name="noUsage" required /> عدم مصرف را با شواهد سرویس‌دهنده تأیید می‌کنم.</label>}
      <label className="block">ارجاع شواهد (شمارهٔ درخواست یا تیکت، بدون رمز و اطلاعات مشتری)<input name="evidenceReference" required minLength={5} maxLength={255} className="block w-full rounded border p-2" /></label>
      <label className="block">دلیل تصمیم<textarea name="reason" required minLength={10} maxLength={1000} className="block w-full rounded border p-2" /></label>
      <label className="block"><input name="stopped" type="checkbox" required /> پایان اجرای عملیات را بررسی کرده‌ام؛ پردازش فعالی باقی نمانده است.</label>
      <button disabled={busy} className="rounded bg-slate-900 p-2 text-white">ثبت نهایی و حسابرسی</button>
    </form>}
  </section>;
}
