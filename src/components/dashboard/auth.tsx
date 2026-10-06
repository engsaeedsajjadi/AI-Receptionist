"use client";
import type { UserRole } from "@/lib/permissions";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createSessionBus, type SessionBus } from "@/lib/cross-tab";

export type DashboardUser = {
  id: string;
  businessId: string;
  name: string;
  email: string;
  role: UserRole;
};

type AuthContextValue = {
  user: DashboardUser | null;
  businessName: string | null;
  loading: boolean;
  login: (email: string, password: string, code?: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Authenticated fetch (access token from memory, auto-refresh on 401). */
  api: (path: string, init?: RequestInit) => Promise<Response>;
  apiJson: <T>(path: string, init?: RequestInit) => Promise<T>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

async function parseError(res: Response): Promise<Error> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    return new Error(body?.error?.message ?? `Request failed (${res.status})`);
  } catch {
    return new Error(`Request failed (${res.status})`);
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  // Access token lives ONLY in memory (never localStorage). Refresh token is
  // an HttpOnly cookie managed by the API routes.
  const accessToken = useRef<string | null>(null);
  const [user, setUser] = useState<DashboardUser | null>(null);
  const [businessName, setBusinessName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshInFlight = useRef<Promise<string | null> | null>(null);
  const busRef = useRef<SessionBus | null>(null);
  const doRefresh = useCallback(async (): Promise<string | null> => {
    try {
      const res = await fetch("/api/v1/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { accessToken?: string };
      accessToken.current = body.accessToken ?? null;
      return accessToken.current;
    } catch {
      return null;
    }
  }, []);

  const refresh = useCallback((): Promise<string | null> => {
    if (!refreshInFlight.current) {
      refreshInFlight.current = doRefresh().finally(() => { refreshInFlight.current = null; });
    }
    return refreshInFlight.current;
  }, [doRefresh]);

  const fetchMe = useCallback(async (token: string) => {
    const res = await fetch("/api/v1/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw await parseError(res);
    const body = (await res.json()) as { user: DashboardUser; business?: { name?: string } };
    setUser(body.user);
    setBusinessName(body.business?.name ?? null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const token = await refresh();
      if (!cancelled && token) {
        try {
          await fetchMe(token);
        } catch {
          accessToken.current = null;
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh, fetchMe]);

  // Cross-tab session coordination: a logout in another tab must not leave this
  // tab holding a revoked session, and a login elsewhere should hydrate this tab.
  useEffect(() => {
    const bus = createSessionBus();
    busRef.current = bus;
    const unsubscribe = bus.subscribe((event) => {
      if (event.type === "logout") {
        // The refresh cookie is gone; drop the in-memory access token now
        // instead of waiting for the next 401.
        accessToken.current = null;
        setUser(null);
        setBusinessName(null);
        return;
      }
      void (async () => {
        const token = await refresh();
        if (!token) {
          accessToken.current = null;
          setUser(null);
          return;
        }
        try {
          await fetchMe(token);
        } catch {
          accessToken.current = null;
          setUser(null);
        }
      })();
    });
    return () => {
      unsubscribe();
      bus.close();
      busRef.current = null;
    };
  }, [refresh, fetchMe]);

  const login = useCallback(
    async (email: string, password: string, code?: string) => {
      const res = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, code }),
      });
      if (!res.ok) throw await parseError(res);
      const body = (await res.json()) as { accessToken: string };
      accessToken.current = body.accessToken;
      await fetchMe(body.accessToken);
      busRef.current?.announce("login");
    },
    [fetchMe],
  );

  const logout = useCallback(async () => {
    try {
      await fetch("/api/v1/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    } catch {
      // ignore — local state is cleared regardless
    }
    accessToken.current = null;
    setUser(null);
    setBusinessName(null);
    busRef.current?.announce("logout");
  }, []);

  const api = useCallback(
    async (path: string, init?: RequestInit): Promise<Response> => {
      const call = (token: string | null) =>
        fetch(path, {
          ...init,
          headers: {
            ...(init?.headers ?? {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        });
      let res = await call(accessToken.current);
      if (res.status === 401) {
        const token = await refresh();
        if (token) {
          res = await call(token);
        } else {
          accessToken.current = null;
          setUser(null);
        }
      }
      return res;
    },
    [refresh],
  );

  const apiJson = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const res = await api(path, init);
      if (!res.ok) throw await parseError(res);
      return (await res.json()) as T;
    },
    [api],
  );

  const value = useMemo(
    () => ({ user, businessName, loading, login, logout, api, apiJson }),
    [user, businessName, loading, login, logout, api, apiJson],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
