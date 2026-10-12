"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/dashboard/auth";

export type TenantBranding = {
  productName: string;
  accentColor: string;
  logoUrl: string;
  supportEmail: string;
  customDomain: string;
  hidePlatformBranding: boolean;
};

export type BrandingState = { enabled: boolean; branding: TenantBranding };

export const PLATFORM_BRANDING: TenantBranding = {
  productName: "AI Receptionist",
  accentColor: "#0f172a",
  logoUrl: "",
  supportEmail: "",
  customDomain: "",
  hidePlatformBranding: false,
};

/**
 * Pure helper (unit-testable without a DOM): the CSS custom property the shell
 * reads for the tenant accent colour.
 */
export function brandingCssVariables(branding: TenantBranding): Record<string, string> {
  return { "--brand-accent": branding.accentColor };
}

/**
 * Loads the tenant's white-label settings once the session is known. Any failure
 * (unentitled tenant, transient error) falls back to the platform branding — the
 * dashboard must never render a broken or half-applied brand.
 */
export function useTenantBranding(): BrandingState {
  const { user, apiJson } = useAuth();
  const [state, setState] = useState<BrandingState>({ enabled: false, branding: PLATFORM_BRANDING });

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    apiJson<BrandingState>("/api/v1/business/branding")
      .then((value) => {
        if (!cancelled && value?.branding) setState({ enabled: Boolean(value.enabled), branding: value.branding });
      })
      .catch(() => {
        if (!cancelled) setState({ enabled: false, branding: PLATFORM_BRANDING });
      });
    return () => {
      cancelled = true;
    };
  }, [apiJson, user]);

  return state;
}
