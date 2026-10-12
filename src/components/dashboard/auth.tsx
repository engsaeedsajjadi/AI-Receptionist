"use client";

import type { UserRole } from "@/lib/permissions";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  createSessionBus,
  type SessionBus,
} from "@/lib/cross-tab";

export type DashboardUser = {
  id: string;
  businessId: string;
  name: string;
  email: string;
  role: UserRole;
};

export type DashboardFeatures = {
  agent: boolean;
  knowledge: boolean;
  voice: boolean;
  crm: boolean;
  automation: boolean;
  whiteLabel: boolean;
};

const DEFAULT_FEATURES: DashboardFeatures = {
  agent: true,
  knowledge: true,
  voice: true,
  crm: true,
  automation: true,
  whiteLabel: false,
};

type AuthContextValue = {
  user: DashboardUser | null;
  businessName: string | null;
  features: DashboardFeatures;
  loading: boolean;

  login: (
    email: string,
    password: string,
    code?: string,
  ) => Promise<void>;

  logout: () => Promise<void>;

  /**
   * Authenticated fetch.
   *
   * Access token stays only in memory.
   * A 401 triggers one refresh attempt using the HttpOnly refresh cookie.
   */
  api: (
    path: string,
    init?: RequestInit,
  ) => Promise<Response>;

  apiJson: <T>(
    path: string,
    init?: RequestInit,
  ) => Promise<T>;
};

const AuthContext =
  createContext<AuthContextValue | null>(null);

async function parseError(
  res: Response,
): Promise<Error> {
  try {
    const body = (await res.json()) as {
      error?: {
        code?: string;
        message?: string;
      };
    };

    return new Error(
      body?.error?.message ??
        `Request failed (${res.status})`,
    );
  } catch {
    return new Error(
      `Request failed (${res.status})`,
    );
  }
}

export function AuthProvider({
  children,
}: {
  children: ReactNode;
}) {
  /**
   * Access token must never be persisted in localStorage/sessionStorage.
   * Refresh token is managed by the server using an HttpOnly cookie.
   */
  const accessToken =
    useRef<string | null>(null);

  const refreshInFlight =
    useRef<Promise<string | null> | null>(null);

  const busRef =
    useRef<SessionBus | null>(null);

  const [user, setUser] =
    useState<DashboardUser | null>(null);

  const [businessName, setBusinessName] =
    useState<string | null>(null);

  const [features, setFeatures] =
    useState<DashboardFeatures>(
      DEFAULT_FEATURES,
    );

  const [loading, setLoading] =
    useState(true);

  /**
   * Clear all tenant/session-derived client state.
   */
  const clearLocalSession =
    useCallback(() => {
      accessToken.current = null;

      setUser(null);
      setBusinessName(null);
      setFeatures(DEFAULT_FEATURES);
    }, []);

  /**
   * Refresh the short-lived access token.
   */
  const doRefresh =
    useCallback(
      async (): Promise<string | null> => {
        try {
          const res = await fetch(
            "/api/v1/auth/refresh",
            {
              method: "POST",
              headers: {
                "Content-Type":
                  "application/json",
              },
              body: "{}",
            },
          );

          if (!res.ok) {
            accessToken.current = null;
            return null;
          }

          const body =
            (await res.json()) as {
              accessToken?: string;
            };

          accessToken.current =
            body.accessToken ?? null;

          return accessToken.current;
        } catch {
          accessToken.current = null;
          return null;
        }
      },
      [],
    );

  /**
   * Only one refresh request may run at a time.
   */
  const refresh = useCallback(
    (): Promise<string | null> => {
      if (!refreshInFlight.current) {
        refreshInFlight.current =
          doRefresh().finally(() => {
            refreshInFlight.current = null;
          });
      }

      return refreshInFlight.current;
    },
    [doRefresh],
  );

  /**
   * Hydrate:
   * - authenticated user
   * - business name
   * - tenant feature flags
   *
   * Feature flags intentionally use the same defaults
   * as tenantFeaturesSchema on the backend.
   */
  const fetchMe = useCallback(
    async (token: string) => {
      const headers = {
        Authorization: `Bearer ${token}`,
      };

      const [meRes, settingsRes] =
        await Promise.all([
          fetch("/api/v1/auth/me", {
            headers,
          }),

          fetch(
            "/api/v1/business/settings",
            {
              headers,
            },
          ),
        ]);

      if (!meRes.ok) {
        throw await parseError(meRes);
      }

      const body =
        (await meRes.json()) as {
          user: DashboardUser;
          business?: {
            name?: string;
          };
        };

      setUser(body.user);

      setBusinessName(
        body.business?.name ?? null,
      );

      /**
       * Settings failure must not break authentication.
       *
       * Backend authorization remains authoritative.
       * UI falls back to documented tenant defaults.
       */
      if (!settingsRes.ok) {
        setFeatures(DEFAULT_FEATURES);
        return;
      }

      try {
        const settingsBody =
          (await settingsRes.json()) as {
            settings?: {
              features?: Partial<DashboardFeatures>;
            };
          };

        setFeatures({
          ...DEFAULT_FEATURES,
          ...(settingsBody.settings
            ?.features ?? {}),
        });
      } catch {
        setFeatures(DEFAULT_FEATURES);
      }
    },
    [],
  );

  /**
   * Initial session hydration.
   */
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const token = await refresh();

      if (!cancelled && token) {
        try {
          await fetchMe(token);
        } catch {
          if (!cancelled) {
            clearLocalSession();
          }
        }
      }

      if (!cancelled) {
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    refresh,
    fetchMe,
    clearLocalSession,
  ]);

  /**
   * Cross-tab login/logout coordination.
   *
   * A logout in another tab immediately drops local credentials.
   * A login in another tab rehydrates this tab using the refresh cookie.
   */
  useEffect(() => {
    const bus = createSessionBus();

    busRef.current = bus;

    const unsubscribe =
      bus.subscribe((event) => {
        if (event.type === "logout") {
          clearLocalSession();
          return;
        }

        void (async () => {
          const token = await refresh();

          if (!token) {
            clearLocalSession();
            return;
          }

          try {
            await fetchMe(token);
          } catch {
            clearLocalSession();
          }
        })();
      });

    return () => {
      unsubscribe();
      bus.close();

      if (busRef.current === bus) {
        busRef.current = null;
      }
    };
  }, [
    refresh,
    fetchMe,
    clearLocalSession,
  ]);

  /**
   * Login.
   */
  const login = useCallback(
    async (
      email: string,
      password: string,
      code?: string,
    ) => {
      const res = await fetch(
        "/api/v1/auth/login",
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
          },
          body: JSON.stringify({
            email,
            password,
            code,
          }),
        },
      );

      if (!res.ok) {
        throw await parseError(res);
      }

      const body =
        (await res.json()) as {
          accessToken: string;
        };

      accessToken.current =
        body.accessToken;

      await fetchMe(
        body.accessToken,
      );

      busRef.current?.announce(
        "login",
      );
    },
    [fetchMe],
  );

  /**
   * Logout current session.
   */
  const logout =
    useCallback(async () => {
      try {
        await fetch(
          "/api/v1/auth/logout",
          {
            method: "POST",
            headers: {
              "Content-Type":
                "application/json",
            },
            body: "{}",
          },
        );
      } catch {
        /**
         * Server logout failure must not
         * prevent local credential removal.
         */
      }

      clearLocalSession();

      busRef.current?.announce(
        "logout",
      );
    }, [clearLocalSession]);

  /**
   * Authenticated API helper.
   *
   * On a 401:
   * 1. refresh access token once
   * 2. retry original request
   * 3. if refresh fails, clear local auth state
   */
  const api = useCallback(
    async (
      path: string,
      init?: RequestInit,
    ): Promise<Response> => {
      const call = (
        token: string | null,
      ) =>
        fetch(path, {
          ...init,

          headers: {
            ...(init?.headers ?? {}),

            ...(token
              ? {
                  Authorization:
                    `Bearer ${token}`,
                }
              : {}),
          },
        });

      let res = await call(
        accessToken.current,
      );

      if (res.status !== 401) {
        return res;
      }

      const token = await refresh();

      if (!token) {
        clearLocalSession();
        return res;
      }

      res = await call(token);

      /**
       * If retry is still unauthorized,
       * treat the session as invalid.
       */
      if (res.status === 401) {
        clearLocalSession();
      }

      return res;
    },
    [
      refresh,
      clearLocalSession,
    ],
  );

  /**
   * JSON API wrapper.
   */
  const apiJson = useCallback(
    async <T,>(
      path: string,
      init?: RequestInit,
    ): Promise<T> => {
      const res = await api(
        path,
        init,
      );

      if (!res.ok) {
        throw await parseError(res);
      }

      return (await res.json()) as T;
    },
    [api],
  );

  const value =
    useMemo<AuthContextValue>(
      () => ({
        user,
        businessName,
        features,
        loading,
        login,
        logout,
        api,
        apiJson,
      }),
      [
        user,
        businessName,
        features,
        loading,
        login,
        logout,
        api,
        apiJson,
      ],
    );

  return (
    <AuthContext.Provider
      value={value}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx =
    useContext(AuthContext);

  if (!ctx) {
    throw new Error(
      "useAuth must be used inside AuthProvider",
    );
  }

  return ctx;
}