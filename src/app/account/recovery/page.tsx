"use client";
import { useEffect, useState } from "react";
export default function RecoveryPage() {
  const [link, setLink] = useState<{ token: string; purpose: string } | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const token = params.get("token");
    if (token) { queueMicrotask(() => setLink({ token, purpose: params.get("purpose") ?? "password_reset" })); window.history.replaceState({}, "", window.location.pathname); }
  }, []);
  return <main dir="rtl" className="mx-auto max-w-md p-8"><h1 className="mb-5 text-2xl font-bold">امنیت حساب</h1>
    <form className="space-y-4 rounded-2xl border bg-white p-6" onSubmit={async (event) => {
      event.preventDefault(); setBusy(true); setMessage("");
      try {
        const body = link ? { action: "consume", ...link, password: password || undefined } : { action: "request_reset", email };
        const response = await fetch("/api/v1/auth/recovery", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message ?? "عملیات ناموفق بود");
        setMessage(link ? "انجام شد. اکنون وارد حساب شوید." : "اگر حسابی با این ایمیل وجود داشته باشد، پیوند بازیابی ارسال می‌شود.");
        setPassword("");
      } catch (error) { setMessage(error instanceof Error ? error.message : "خطا"); } finally { setBusy(false); }
    }}>
      {!link && <label className="block">ایمیل<input required type="email" autoComplete="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} className="mt-2 w-full rounded border p-2" /></label>}
      {link?.purpose === "password_reset" && <label className="block">گذرواژه جدید<input required type="password" autoComplete="new-password" minLength={8} maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} className="mt-2 w-full rounded border p-2" /></label>}
      <button disabled={busy} className="rounded bg-slate-900 px-4 py-2 text-white">{busy ? "در حال انجام…" : link ? "تأیید" : "ارسال پیوند بازیابی"}</button>
      <p role="status">{message}</p><a href="/dashboard/login" className="block underline">ورود به حساب</a>
    </form></main>;
}
