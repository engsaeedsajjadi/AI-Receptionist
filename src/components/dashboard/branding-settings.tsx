"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/dashboard/auth";
import { PLATFORM_BRANDING, type BrandingState, type TenantBranding } from "@/components/dashboard/branding";

const EMPTY: TenantBranding = PLATFORM_BRANDING;

/**
 * White-labeling card. The API enforces the `whiteLabel` entitlement, so the
 * form explains the state instead of pretending the settings were saved: an
 * unentitled tenant sees the platform defaults and a disabled form.
 */
export function BrandingSettings() {
  const { apiJson } = useAuth();
  const [state, setState] = useState<BrandingState>({ enabled: false, branding: EMPTY });
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiJson<BrandingState>("/api/v1/business/branding")
      .then((value) => {
        if (cancelled) return;
        setState({ enabled: Boolean(value.enabled), branding: { ...EMPTY, ...value.branding } });
      })
      .catch(() => {
        if (!cancelled) setState({ enabled: false, branding: EMPTY });
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [apiJson]);

  if (!loaded) return null;

  const patch = (key: keyof TenantBranding, value: string | boolean) =>
    setState((current) => ({ ...current, branding: { ...current.branding, [key]: value } }));

  return (
    <form
      className="space-y-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setMessage(null);
        apiJson<BrandingState>("/api/v1/business/branding", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(state.branding),
        })
          .then((value) => {
            setState({ enabled: Boolean(value.enabled), branding: { ...EMPTY, ...value.branding } });
            setMessage("برندسازی ذخیره شد.");
          })
          .catch((error: Error) => setMessage(error.message))
          .finally(() => setBusy(false));
      }}
    >
      <h2 className="text-sm font-semibold">برندسازی اختصاصی</h2>
      {state.enabled ? (
        <>
          <label className="block text-sm">
            نام محصول
            <input
              value={state.branding.productName}
              onChange={(event) => patch("productName", event.target.value)}
              placeholder="خالی = نام پیش‌فرض سکو"
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            نشانی نشان (https)
            <input
              value={state.branding.logoUrl}
              onChange={(event) => patch("logoUrl", event.target.value)}
              dir="ltr"
              placeholder="https://example.com/logo.png"
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            رنگ سازمانی
            <input
              type="color"
              value={state.branding.accentColor}
              onChange={(event) => patch("accentColor", event.target.value)}
              className="mt-1 h-9 w-20 rounded border border-slate-200"
            />
          </label>
          <label className="block text-sm">
            ایمیل پشتیبانی
            <input
              value={state.branding.supportEmail}
              onChange={(event) => patch("supportEmail", event.target.value)}
              dir="ltr"
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            دامنه اختصاصی
            <input
              value={state.branding.customDomain}
              onChange={(event) => patch("customDomain", event.target.value)}
              dir="ltr"
              placeholder="app.example.com"
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={state.branding.hidePlatformBranding}
              onChange={(event) => patch("hidePlatformBranding", event.target.checked)}
            />
            نام سکو نمایش داده نشود
          </label>
          <button type="submit" disabled={busy} className="rounded-xl bg-slate-900 px-6 py-2 text-sm font-semibold text-white disabled:opacity-50">
            ذخیره برندسازی
          </button>
        </>
      ) : (
        <p className="text-sm text-slate-600">
          برندسازی اختصاصی برای این فضای کاری فعال نیست؛ نام و نشان پیش‌فرض سکو نمایش داده می‌شود.
        </p>
      )}
      {message ? <p className="text-sm text-slate-600">{message}</p> : null}
    </form>
  );
}
