"use client";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/dashboard/auth";
type Session = { id: string; userAgent: string | null; createdAt: string; expiresAt: string };
export default function SecurityPage() {
  const { apiJson, logout } = useAuth();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [security, setSecurity] = useState({ mfaEnabled: false, emailVerified: false, recoveryCodesRemaining: 0 });
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [secret, setSecret] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    const [s, profile] = await Promise.all([apiJson<{ sessions: Session[] }>("/api/v1/auth/sessions"), apiJson<typeof security>("/api/v1/auth/security")]);
    setSessions(s.sessions); setSecurity(profile);
  }, [apiJson]);
  useEffect(() => { let cancelled = false; Promise.all([apiJson<{ sessions: Session[] }>("/api/v1/auth/sessions"), apiJson<typeof security>("/api/v1/auth/security")]).then(([s, profile]) => { if (!cancelled) { setSessions(s.sessions); setSecurity(profile); } }).catch((e: Error) => { if (!cancelled) setMessage(e.message); }); return () => { cancelled = true; }; }, [apiJson]);
  async function change(action: "setup" | "confirm" | "disable") {
    setBusy(true); setMessage("");
    try {
      const result = await apiJson<{ secret?: string; recoveryCodes?: string[]; signInRequired?: boolean }>("/api/v1/auth/security", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, password, code }) });
      if (result.secret) setSecret(result.secret);
      if (result.recoveryCodes) setRecoveryCodes(result.recoveryCodes);
      setMessage(result.signInRequired ? "تغییر ذخیره شد. کدهای بازیابی را نگه دارید و دوباره وارد شوید." : "کلید را در برنامه Authenticator ثبت و کد تولیدشده را تأیید کنید.");
      setPassword(""); setCode("");
    } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); }
  }
  return <div className="space-y-6"><h1 className="text-2xl font-bold">امنیت و نشست‌ها</h1><p role="status">{message}</p>
    <section className="space-y-3 rounded-2xl border bg-white p-5"><h2 className="font-bold">احراز هویت دومرحله‌ای</h2><p>{security.mfaEnabled ? "فعال" : "غیرفعال"} · کدهای بازیابی باقی‌مانده: {security.recoveryCodesRemaining}</p>
      <label className="block">گذرواژه فعلی<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="mx-2 rounded border p-2" /></label>
      {secret && <p>کلید راه‌اندازی: <code dir="ltr" className="break-all">{secret}</code></p>}
      <label className="block">کد Authenticator یا بازیابی<input autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} className="mx-2 rounded border p-2" /></label>
      <div className="flex gap-3">{!security.mfaEnabled && <button disabled={busy} onClick={() => void change("setup")} className="rounded border p-2">دریافت کلید</button>}{!security.mfaEnabled && <button disabled={busy || !secret} onClick={() => void change("confirm")} className="rounded border p-2">فعال‌سازی</button>}{security.mfaEnabled && <button disabled={busy} onClick={() => void change("disable")} className="rounded border p-2">غیرفعال‌سازی</button>}</div>
      {recoveryCodes.length > 0 && <div><p>این کدها فقط همین بار نمایش داده می‌شوند:</p><pre dir="ltr" className="overflow-auto rounded bg-slate-100 p-3">{recoveryCodes.join("\n")}</pre><button onClick={() => void logout()} className="underline">کدها ذخیره شد؛ خروج برای ورود مجدد</button></div>}
    </section>
    <section className="space-y-3 rounded-2xl border bg-white p-5"><h2 className="font-bold">اتصال ورود سازمانی</h2><p>گذرواژه و در صورت فعال بودن، کد دومرحله‌ای را در بخش بالا وارد کنید.</p><div className="flex gap-3">{(["google", "microsoft"] as const).map((provider) => <button key={provider} className="rounded border p-2" onClick={() => void apiJson<{ url: string }>(`/api/v1/auth/oauth/${provider}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password, code: code || undefined }) }).then((data) => window.location.assign(data.url)).catch((e: Error) => setMessage(e.message))}>اتصال {provider}</button>)}</div></section>
    <section className="rounded-2xl border bg-white p-5"><h2 className="font-bold">تأیید ایمیل</h2><p>{security.emailVerified ? "ایمیل تأیید شده است." : "ایمیل هنوز تأیید نشده است."}</p><button disabled={security.emailVerified} className="mt-3 rounded border p-2" onClick={() => void apiJson("/api/v1/auth/recovery", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "request_verification" }) }).then(() => setMessage("پیوند تأیید ارسال شد.")).catch((e: Error) => setMessage(e.message))}>ارسال پیوند تأیید</button></section>
    <section className="rounded-2xl border bg-white p-5"><h2 className="mb-3 font-bold">نشست‌های فعال</h2>{sessions.map((session) => <div key={session.id} className="flex flex-wrap items-center justify-between gap-2 border-b py-3"><div><p dir="ltr" className="max-w-lg break-all text-xs">{session.userAgent ?? "دستگاه نامشخص"}</p><time>{new Date(session.createdAt).toLocaleString("fa-IR")}</time></div><button className="rounded border p-2" onClick={() => void apiJson("/api/v1/auth/sessions", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: session.id }) }).then(refresh).catch((e: Error) => setMessage(e.message))}>لغو نشست</button></div>)}<button className="mt-4 rounded bg-red-700 p-2 text-white" onClick={() => void apiJson("/api/v1/auth/logout-all", { method: "POST" }).then(logout).catch((e: Error) => setMessage(e.message))}>خروج از همه دستگاه‌ها</button></section>
  </div>;
}
