"use client";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/dashboard/auth";
type Tenant = { id: string; name: string; slug: string; isActive: boolean };
export default function TenantsPage() {
  const { apiJson, user } = useAuth();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Tenant | null>(null);
  const [reason, setReason] = useState("");
  const load = useCallback(async (after?: string) => {
    setBusy(true);
    try {
      const result = await apiJson<{ tenants: Tenant[]; nextCursor: string | null }>(`/api/v1/platform/tenants${after ? `?after=${after}` : ""}`);
      setTenants((previous) => after ? [...previous, ...result.tenants] : result.tenants); setNext(result.nextCursor);
    } catch (e) { setMessage(e instanceof Error ? e.message : "خطا در دریافت اطلاعات"); }
    finally { setBusy(false); }
  }, [apiJson]);
  useEffect(() => {
    if (user?.role !== "SUPER_ADMIN") return;
    let cancelled = false;
    apiJson<{ tenants: Tenant[]; nextCursor: string | null }>("/api/v1/platform/tenants")
      .then((result) => { if (!cancelled) { setTenants(result.tenants); setNext(result.nextCursor); } })
      .catch((error: Error) => { if (!cancelled) setMessage(error.message); });
    return () => { cancelled = true; };
  }, [apiJson, user?.role]);
  if (user?.role !== "SUPER_ADMIN") return <p role="alert">دسترسی فقط برای مدیر سراسری مجاز است.</p>;
  return <section><h1 className="text-2xl font-bold">مدیریت مستأجرها</h1>
    <p className="my-3">احراز هویت دومرحله‌ای الزامی است. غیرفعال‌سازی، نشست‌های کاربران را باطل می‌کند.</p>
    <p role="status">{message}</p>
    <div className="overflow-x-auto"><table className="w-full text-right"><thead><tr><th>نام</th><th>شناسه</th><th>وضعیت</th><th>عملیات</th></tr></thead>
      <tbody>{tenants.map((tenant) => <tr key={tenant.id} className="border-t"><td className="p-3">{tenant.name}</td><td>{tenant.slug}</td><td>{tenant.isActive ? "فعال" : "غیرفعال"}</td><td><button disabled={busy} className="rounded border p-2" onClick={() => { setSelected(tenant); setReason(""); }}>{tenant.isActive ? "غیرفعال‌سازی" : "فعال‌سازی"}</button></td></tr>)}</tbody></table></div>
    {next && <button disabled={busy} onClick={() => void load(next)} className="my-3 rounded border p-2">نمایش بیشتر</button>}
    {selected && <form className="mt-6 space-y-3 rounded border p-4" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setMessage("");
      try {
        const result = await apiJson<{ id: string; isActive: boolean }>("/api/v1/platform/tenants", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: selected.id, isActive: !selected.isActive, reason }) });
        setTenants((previous) => previous.map((tenant) => tenant.id === result.id ? { ...tenant, isActive: result.isActive } : tenant)); setSelected(null); setMessage("وضعیت ثبت شد.");
      } catch (error) { setMessage(error instanceof Error ? error.message : "خطا در ثبت"); }
      finally { setBusy(false); }
    }}><p>{selected.name}: {selected.isActive ? "غیرفعال‌سازی و خروج همه کاربران" : "فعال‌سازی"}</p><label className="block">دلیل تغییر (حداقل ۱۰ نویسه)<textarea value={reason} onChange={(e) => setReason(e.target.value)} required minLength={10} maxLength={1000} className="block w-full rounded border p-2" /></label><button disabled={busy || reason.trim().length < 10} className="rounded bg-slate-900 p-2 text-white">تأیید تغییر</button><button type="button" disabled={busy} onClick={() => setSelected(null)} className="mx-3">انصراف</button></form>}
  </section>;
}
