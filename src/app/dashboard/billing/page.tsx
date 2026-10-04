"use client";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/dashboard/auth";
type Invoice = { id: string; plan: string; amountMinor: number; currency: string; status: string; issuer: string; customerName: string; paymentInstructions: string; createdAt: string; paidAt: string | null; paymentReference: string | null };
type Billing = { plan: string; subscription: { periodEnd: string; cancelAtPeriodEnd: boolean } | null; invoices: Invoice[]; availablePlans: { plan: string; amountMinor: number; currency: string }[] };
function money(value: number, currency: string) { return new Intl.NumberFormat("fa-IR", { style: "currency", currency }).format(value / (currency === "IRR" ? 1 : 100)); }
export default function BillingPage() {
  const { apiJson } = useAuth(); const [data, setData] = useState<Billing | null>(null);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [invoice, setInvoice] = useState<Invoice | null>(null);
  const pending = useRef<{ plan: string; idempotencyKey: string } | null>(null);
  useEffect(() => { let disposed = false; apiJson<Billing>("/api/v1/billing").then((result) => { if (!disposed) setData(result); }).catch((e: Error) => { if (!disposed) setError(e.message); }); return () => { disposed = true; }; }, [apiJson]);
  async function mutate(method: string, body: unknown) {
    setBusy(true); setError("");
    try { await apiJson("/api/v1/billing", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); pending.current = null; setInvoice(null); setData(await apiJson<Billing>("/api/v1/billing")); }
    catch (e) { setError(e instanceof Error ? e.message : "خطا در ثبت"); } finally { setBusy(false); }
  }
  return <section><h1 className="text-2xl font-bold">اشتراک و صورتحساب</h1><p role="alert">{error}</p>
    <p className="my-3">پرداخت با فاکتور و تأیید دریافت وجه توسط مدیر سامانه انجام می‌شود. تمدید و برداشت وجه خودکار نیست.</p>
    {data && <><p>طرح فعلی: <b>{data.plan}</b>{data.subscription?.periodEnd && <> — پایان دوره: {new Date(data.subscription.periodEnd).toLocaleString("fa-IR")}</>}</p>
      {data.plan !== "FREE" && data.subscription && <button disabled={busy} className="my-3 rounded border p-2" onClick={() => void mutate("PATCH", { cancelAtPeriodEnd: !data.subscription!.cancelAtPeriodEnd })}>{data.subscription.cancelAtPeriodEnd ? "اجازه تمدید دوباره" : "لغو تمدید و ابطال فاکتورهای باز"}</button>}
      <div className="my-4 flex flex-wrap gap-3">{data.availablePlans.map((plan) => <button disabled={busy} className="rounded-xl border bg-white p-4" key={plan.plan} onClick={() => { if (pending.current?.plan !== plan.plan) pending.current = { plan: plan.plan, idempotencyKey: crypto.randomUUID() }; void mutate("POST", pending.current); }}>درخواست فاکتور {plan.plan}<br />{money(plan.amountMinor, plan.currency)} / ماه</button>)}</div>
      {!data.availablePlans.length && <p>قیمت طرح‌های STARTER، BUSINESS و ENTERPRISE هنوز توسط مدیر سامانه تنظیم نشده است.</p>}
      <h2 className="my-3 text-xl font-bold">فاکتورها</h2><div className="overflow-x-auto"><table className="w-full text-right"><thead><tr><th>طرح</th><th>مبلغ</th><th>وضعیت</th><th>عملیات</th></tr></thead><tbody>{data.invoices.map((item) => <tr className="border-t" key={item.id}><td className="p-3">{item.plan}</td><td>{money(item.amountMinor, item.currency)}</td><td>{({ open: "در انتظار پرداخت", paid: "پرداخت ثبت شده", void: "باطل" })[item.status] ?? item.status}</td><td><button className="rounded border p-2" onClick={() => setInvoice(item)}>مشاهده</button>{item.status === "open" && <button className="mx-3" disabled={busy} onClick={() => void mutate("DELETE", { id: item.id })}>ابطال</button>}</td></tr>)}</tbody></table></div></>}
    {invoice && <article id="print-invoice" className="mt-6 space-y-3 rounded border bg-white p-6"><h2 className="text-xl font-bold">صورتحساب اشتراک</h2><p className="break-all">شناسه: {invoice.id}</p><p className="whitespace-pre-wrap">صادرکننده: {invoice.issuer}</p><p>مشتری: {invoice.customerName}</p><p>طرح: {invoice.plan} — یک ماه تقویمی</p><p>مبلغ: {money(invoice.amountMinor, invoice.currency)}</p><p>تاریخ صدور: {new Date(invoice.createdAt).toLocaleString("fa-IR")}</p><p>وضعیت: {invoice.status}</p><p className="whitespace-pre-wrap">{invoice.paymentInstructions}</p>{invoice.paymentReference && <p>مرجع پرداخت: {invoice.paymentReference}</p>}<div className="print:hidden"><button className="rounded border p-2" onClick={() => window.print()}>چاپ / ذخیره PDF</button><button className="mx-3" onClick={() => setInvoice(null)}>بستن</button></div></article>}
    <style>{`@media print { body * { visibility: hidden; } #print-invoice, #print-invoice * { visibility: visible; } #print-invoice { position: absolute; top: 0; left: 0; width: 100%; margin: 0; } }`}</style>
  </section>;
}
