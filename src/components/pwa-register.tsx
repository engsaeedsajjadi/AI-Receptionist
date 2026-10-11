"use client";

import { useEffect } from "react";

/**
 * Register only the production service worker. E2E/dev sessions must never be
 * controlled by a stale worker. The worker intentionally does not cache API
 * responses or authenticated dashboard documents.
 */
export function PwaRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      // PWA support is an enhancement; registration failure must not break auth.
    });
  }, []);
  return null;
}
