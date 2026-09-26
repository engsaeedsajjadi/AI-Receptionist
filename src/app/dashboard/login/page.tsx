"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/dashboard/auth";

export default function LoginPage() {
  const { user, loading, login } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && user) router.replace("/dashboard");
  }, [loading, user, router]);

  if (loading) return null;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4">
      <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
        <h1 className="text-lg font-bold">ورود به داشبورد</h1>
        <p className="mt-1 text-sm text-slate-500">نشست شما با توکن کوتاه‌مدت و کوکی امن محافظت می‌شود.</p>
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            login(email.trim(), password)
              .then(() => router.replace("/dashboard"))
              .catch((err: Error) => setError(err.message))
              .finally(() => setBusy(false));
          }}
        >
          <label className="block text-sm">
            ایمیل
            <input
              type="email"
              dir="ltr"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400"
            />
          </label>
          <label className="block text-sm">
            گذرواژه
            <input
              type="password"
              dir="ltr"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400"
            />
          </label>
          {error ? <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p> : null}
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-xl bg-slate-900 py-2.5 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {busy ? "در حال ورود…" : "ورود"}
          </button>
        </form>
      </div>
    </main>
  );
}
