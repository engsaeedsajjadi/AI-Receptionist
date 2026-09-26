"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/dashboard/auth";
import { LoadingState, PageHeader } from "@/components/dashboard/ui";

type Settings = {
  recording_enabled?: boolean;
  transcription_enabled?: boolean;
  retention_days?: number;
  disclosure_message?: string;
  scheduling?: { slotMinutes?: number; holidays?: string[] };
  transfer?: { number?: string; fallbackNumber?: string; timeoutSeconds?: number };
};

export default function SettingsPage() {
  const { apiJson } = useAuth();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [profile, setProfile] = useState({ name: "", phone: "", address: "", timezone: "Asia/Tehran" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiJson<{ settings: Settings }>("/api/v1/business/settings"),
      apiJson<{ name: string; phone: string | null; address: string | null; timezone: string }>("/api/v1/business"),
    ])
      .then(([s, b]) => {
        if (cancelled) return;
        setSettings(s.settings);
        setProfile({ name: b.name, phone: b.phone ?? "", address: b.address ?? "", timezone: b.timezone });
      })
      .catch(() => {
        if (!cancelled) setSettings({});
      });
    return () => {
      cancelled = true;
    };
  }, [apiJson]);

  if (!settings) return <LoadingState />;

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setSettings((s) => ({ ...(s ?? {}), [key]: value }));

  return (
    <div>
      <PageHeader title="تنظیمات" desc="مشخصات کسب‌وکار، ساعات کاری و انتقال تماس" />
      <div className="grid gap-4 lg:grid-cols-2">
        <form
          className="space-y-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setMessage(null);
            apiJson("/api/v1/business", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(profile),
            })
              .then(() => setMessage("مشخصات ذخیره شد."))
              .catch((err: Error) => setMessage(err.message))
              .finally(() => setBusy(false));
          }}
        >
          <h2 className="text-sm font-semibold">مشخصات کسب‌وکار</h2>
          <label className="block text-sm">نام<input value={profile.name} onChange={(e) => setProfile((p) => ({ ...p, name: e.target.value }))} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" /></label>
          <label className="block text-sm">تلفن<input value={profile.phone} onChange={(e) => setProfile((p) => ({ ...p, phone: e.target.value }))} dir="ltr" className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" /></label>
          <label className="block text-sm">نشانی<textarea value={profile.address} onChange={(e) => setProfile((p) => ({ ...p, address: e.target.value }))} rows={2} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" /></label>
          <label className="block text-sm">منطقه زمانی
            <select value={profile.timezone} onChange={(e) => setProfile((p) => ({ ...p, timezone: e.target.value }))} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm">
              <option value="Asia/Tehran">Asia/Tehran</option>
              <option value="UTC">UTC</option>
            </select>
          </label>
          <button type="submit" disabled={busy} className="rounded-xl bg-slate-900 px-6 py-2 text-sm font-semibold text-white disabled:opacity-50">ذخیره مشخصات</button>
        </form>

        <form
          className="space-y-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setMessage(null);
            apiJson("/api/v1/business/settings", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ settings }),
            })
              .then(() => setMessage("تنظیمات ذخیره شد."))
              .catch((err: Error) => setMessage(err.message))
              .finally(() => setBusy(false));
          }}
        >
          <h2 className="text-sm font-semibold">انتقال تماس و نوبت‌دهی</h2>
          <label className="block text-sm">شماره انتقال<input value={settings.transfer?.number ?? ""} onChange={(e) => update("transfer", { ...(settings.transfer ?? {}), number: e.target.value })} dir="ltr" placeholder="09xxxxxxxxx" className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" /></label>
          <label className="block text-sm">شماره جایگزین<input value={settings.transfer?.fallbackNumber ?? ""} onChange={(e) => update("transfer", { ...(settings.transfer ?? {}), fallbackNumber: e.target.value })} dir="ltr" className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" /></label>
          <label className="block text-sm">تایم‌اوت انتقال (ثانیه)<input type="number" min={5} max={120} value={settings.transfer?.timeoutSeconds ?? 30} onChange={(e) => update("transfer", { ...(settings.transfer ?? {}), timeoutSeconds: Number(e.target.value) })} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" /></label>
          <label className="block text-sm">مدت نوبت (دقیقه)<input type="number" min={10} max={240} value={settings.scheduling?.slotMinutes ?? 30} onChange={(e) => update("scheduling", { ...(settings.scheduling ?? {}), slotMinutes: Number(e.target.value) })} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" /></label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={settings.recording_enabled ?? true} onChange={(e) => update("recording_enabled", e.target.checked)} />
            ضبط تماس فعال باشد
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={settings.transcription_enabled ?? true} onChange={(e) => update("transcription_enabled", e.target.checked)} />
            تبدیل گفتار به متن فعال باشد
          </label>
          {message ? <p className="text-sm text-slate-600">{message}</p> : null}
          <button type="submit" disabled={busy} className="rounded-xl bg-slate-900 px-6 py-2 text-sm font-semibold text-white disabled:opacity-50">ذخیره تنظیمات</button>
        </form>
      </div>
    </div>
  );
}
