"use client";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/dashboard/auth";
type Invoice = { id: string; businessId: string; customerName: string; plan: string; amountMinor: number; currency: string };
export default function PlatformBillingPage() {
  const { apiJson, user } = useAuth(); const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [selected, setSelected] = useState<Invoice | null>(null); const [reference, setReference] = useState("");
  const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { if (user?.role !== "SUPER_ADMIN") return; let disposed = false;
    apiJson<{ invoices: Invoice[] }>("/api/v1/platform/billing").then((result) => { if (!disposed) setInvoices(result.invoices); }).catch((e: Error) => { if (!disposed) setMessage(e.message); }); return () => { disposed = true; };
  }, [apiJson, user?.role]);
  if (user?.role !== "SUPER_ADMIN") return <p role="alert">دسترسی فقط برای مدیر سراسری مجاز است.</p>;
  return <section><h1 className="text-2xl font-bold">تطبیق پرداخت فاکتورها</h1><p className="my-3">فقط پس از تطبیق دریافت کامل وجه در حساب بانکی، پرداخت را ثبت کنید. این فرم انتقال وجه انجام نمی‌دهد.</p><p role="status">{message}</p>
    <ul>{invoices.map((invoice) => <li className="my-3 rounded border p-3" key={invoice.id}>{invoice.customerName} — {invoice.plan} — {new Intl.NumberFormat("fa-IR", { style: "currency", currency: invoice.currency }).format(invoice.amountMinor / (invoice.currency === "IRR" ? 1 : 100))}<button disabled={busy} className="mx-3 rounded border p-2" onClick={() => { setSelected(invoice); setReference(""); }}>ثبت دریافت وجه</button></li>)}</ul>
    {selected && <form className="space-y-3 rounded border p-4" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setMessage("");
      try { await apiJson("/api/v1/platform/billing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: selected.id, businessId: selected.businessId, amountMinor: selected.amountMinor, currency: selected.currency, paymentReference: reference }) }); setInvoices((previous) => previous.filter((invoice) => invoice.id !== selected.id)); setSelected(null); setMessage("پرداخت ثبت و دوره اشتراک فعال شد."); }
      catch (error) { setMessage(error instanceof Error ? error.message : "خطا در ثبت"); } finally { setBusy(false); }
    }}><p className="break-all">فاکتور: {selected.id}</p><label className="block">مرجع یکتای پرداخت بانکی<input required minLength={5} maxLength={255} value={reference} onChange={(e) => setReference(e.target.value)} className="block w-full rounded border p-2" /></label><label className="block"><input type="checkbox" required /> دریافت کامل مبلغ و ارز فاکتور را در حساب بانکی بررسی کرده‌ام.</label><button disabled={busy} className="rounded bg-slate-900 p-2 text-white">ثبت قطعی دریافت وجه</button><button type="button" disabled={busy} className="mx-3" onClick={() => setSelected(null)}>انصراف</button></form>}
  </section>;
}
