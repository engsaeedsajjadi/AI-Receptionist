"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
export default function OAuthMfaPage() {
  const router = useRouter();
  const [code, setCode] = useState(""); const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  return <main dir="rtl" className="mx-auto max-w-md p-8"><h1 className="mb-4 text-xl font-bold">تأیید ورود دومرحله‌ای</h1><form className="space-y-4 rounded-xl border bg-white p-5" onSubmit={async (e) => { e.preventDefault(); setBusy(true); try {
    const response = await fetch("/api/v1/auth/oauth/complete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error?.message ?? "ورود ناموفق"); router.replace("/dashboard");
  } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); } }}><label>کد Authenticator یا بازیابی<input required autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} dir="ltr" className="mt-2 w-full rounded border p-2" /></label><button disabled={busy} className="rounded bg-slate-900 p-2 text-white">تأیید ورود</button><p role="status">{message}</p><a className="block underline" href="/dashboard/login">بازگشت به ورود</a></form></main>;
}
