"use client";

import { Fragment, useCallback, useEffect, useState, type ReactNode } from "react";
import { useAuth } from "@/components/dashboard/auth";

export function Card({ title, value, sub }: { title: string; value: ReactNode; sub?: string }) {
  return (
    <article className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
      <p className="text-sm text-slate-500">{title}</p>
      <p className="mt-2 text-2xl font-bold text-slate-900">{value}</p>
      {sub ? <p className="mt-1 text-xs text-slate-500">{sub}</p> : null}
    </article>
  );
}

export function PageHeader({ title, desc, actions }: { title: string; desc?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-bold text-slate-900">{title}</h1>
        {desc ? <p className="mt-1 text-sm text-slate-500">{desc}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function LoadingState({ label = "در حال بارگذاری…" }: { label?: string }) {
  return (
    <div className="rounded-2xl bg-white p-8 text-center text-sm text-slate-500 shadow-sm ring-1 ring-slate-200">
      <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700 align-middle" />
      <span className="mr-2">{label}</span>
    </div>
  );
}

export function EmptyState({ label = "رکوردی وجود ندارد." }: { label?: string }) {
  return (
    <div className="rounded-2xl bg-white p-8 text-center text-sm text-slate-500 shadow-sm ring-1 ring-slate-200">
      {label}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-center shadow-sm">
      <p className="text-sm font-medium text-red-800">{message}</p>
      {onRetry ? (
        <button
          onClick={onRetry}
          className="mt-3 rounded-lg bg-red-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-800"
        >
          تلاش مجدد
        </button>
      ) : null}
    </div>
  );
}

export function Badge({ children, tone = "slate" }: { children: ReactNode; tone?: "slate" | "green" | "amber" | "red" | "blue" }) {
  const tones: Record<string, string> = {
    slate: "bg-slate-100 text-slate-700",
    green: "bg-green-100 text-green-800",
    amber: "bg-amber-100 text-amber-800",
    red: "bg-red-100 text-red-800",
    blue: "bg-blue-100 text-blue-800",
  };
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}

export type Column<T> = {
  key: string;
  label: string;
  render?: (row: T) => ReactNode;
};

export type FilterDef = {
  key: string;
  label: string;
  options: Array<{ value: string; label: string }>;
};

type Paginated<T> = {
  data: T[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
  /** Keyset cursor for the next page; sent back as `?cursor=` (server-side, stable). */
  nextCursor?: string | null;
  hasMore?: boolean;
};

function asPaginated<T>(json: unknown): Paginated<T> {
  if (Array.isArray(json)) {
    return { data: json as T[], pagination: { page: 1, limit: json.length, total: json.length, totalPages: 1 } };
  }
  return json as Paginated<T>;
}

/**
 * Which window the next request should use.
 *
 * Rows are ordered by creation time (descending) and appended on page
 * boundaries, so once the server has told us the total we can keep using the
 * cheaper, stable cursor for every page after the first; otherwise (or once we
 * know we are on the last page) we fall back to the offset window. New rows land
 * at the top, so they never shift a later cursor page.
 */
export function nextPageQuery(input: {
  /** Page the client is moving to. */
  targetPage: number;
  limit: number;
  /** Total rows the last response reported (undefined when unknown). */
  total?: number;
  /** Cursor the last response returned. */
  cursor?: string | null;
  /** Whether the last response had more rows (undefined when unknown). */
  hasMore?: boolean;
  search?: Record<string, string>;
}): URLSearchParams {
  const { targetPage, limit, total, cursor, hasMore, search } = input;
  const params = new URLSearchParams({ limit: String(limit) });
  const forward = targetPage > 1;
  const reachesEnd = typeof total === "number" && total > 0 && targetPage * limit >= total;
  if (forward && cursor && !reachesEnd) {
    // Stable keyset window: the server answers page 1 of the cursor.
    params.set("cursor", cursor);
  } else {
    params.set("page", String(targetPage));
  }
  for (const [key, value] of Object.entries(search ?? {})) {
    if (value) params.set(key, value);
  }
  void hasMore;
  return params;
}

export function ResourceTable<T extends { id: string }>({
  endpoint,
  columns,
  searchKey,
  searchPlaceholder,
  filters = [],
  renderDetail,
  rowActions,
  emptyLabel,
}: {
  endpoint: string;
  columns: Column<T>[];
  searchKey?: string;
  searchPlaceholder?: string;
  filters?: FilterDef[];
  renderDetail?: (row: T, refresh: () => void) => ReactNode;
  rowActions?: (row: T, refresh: () => void) => ReactNode;
  emptyLabel?: string;
}) {
  const { apiJson } = useAuth();
  const [data, setData] = useState<T[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 20, total: 0, totalPages: 1 });
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<string | null>(null);

  const [reloadKey, setReloadKey] = useState(0);
  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  /** Any new search/filter term starts a fresh window from the top. */
  const restartWindow = useCallback(() => {
    setPage(1);
    setCursor(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const params = nextPageQuery({
      targetPage: page,
      limit: 20,
      total,
      cursor,
      search: { ...(appliedSearch && searchKey ? { [searchKey]: appliedSearch } : {}), ...filterValues },
    });
    apiJson<unknown>(`${endpoint}?${params.toString()}`)
      .then((json) => {
        if (cancelled) return;
        const paged = asPaginated<T>(json);
        setData(paged.data);
        setPagination(paged.pagination);
        setCursor(paged.nextCursor ?? null);
        setTotal(paged.pagination.total);
        setError(null);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiJson, endpoint, page, appliedSearch, searchKey, filterValues, reloadKey, cursor, total]);

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  return (
    <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3">
        {searchKey ? (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              restartWindow();
              setAppliedSearch(search);
            }}
          >
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={searchPlaceholder ?? "جست‌وجو"}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm outline-none focus:border-slate-400"
            />
            <button type="submit" className="rounded-lg bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-700">
              جست‌وجو
            </button>
          </form>
        ) : null}
        {filters.map((f) => (
          <label key={f.key} className="flex items-center gap-1 text-xs text-slate-500">
            {f.label}
            <select
              value={filterValues[f.key] ?? ""}
              onChange={(e) => {
                restartWindow();
                setFilterValues((prev) => ({ ...prev, [f.key]: e.target.value }));
              }}
              className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm outline-none"
            >
              <option value="">همه</option>
              {f.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>

      {data.length === 0 ? (
        <div className="p-4">
          <EmptyState label={emptyLabel} />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-right text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-xs text-slate-500">
                {columns.map((c) => (
                  <th key={c.key} className="px-4 py-3 font-medium">
                    {c.label}
                  </th>
                ))}
                {rowActions || renderDetail ? <th className="px-4 py-3 font-medium">عملیات</th> : null}
              </tr>
            </thead>
            <tbody>
              {data.map((row) => (
                <Fragment key={row.id}>
                  <tr className="border-b border-slate-50 hover:bg-slate-50">
                    {columns.map((c) => (
                      <td key={c.key} className="max-w-64 truncate px-4 py-2.5">
                        {c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? "—")}
                      </td>
                    ))}
                    {rowActions || renderDetail ? (
                      <td className="px-4 py-2.5">
                        <div className="flex gap-2">
                          {renderDetail ? (
                            <button
                              onClick={() => setExpanded(expanded === row.id ? null : row.id)}
                              className="rounded-lg border border-slate-200 px-3 py-1 text-xs hover:bg-slate-100"
                            >
                              {expanded === row.id ? "بستن" : "جزئیات"}
                            </button>
                          ) : null}
                          {rowActions ? rowActions(row, refresh) : null}
                        </div>
                      </td>
                    ) : null}
                  </tr>
                  {renderDetail && expanded === row.id ? (
                    <tr className="bg-slate-50">
                      <td colSpan={columns.length + 1} className="px-4 py-3">
                        {renderDetail(row, refresh)}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-between border-t border-slate-100 p-3 text-xs text-slate-500">
        <span>
          صفحه {pagination.page} از {pagination.totalPages} — مجموع {pagination.total}
        </span>
        <div className="flex gap-2">
          <button
            disabled={pagination.page <= 1}
            onClick={() => setPage((p) => Math.max(p - 1, 1))}
            className="rounded-lg border border-slate-200 px-3 py-1 disabled:opacity-40"
          >
            قبلی
          </button>
          <button
            disabled={pagination.page >= pagination.totalPages}
            onClick={() => setPage((p) => p + 1)}
            className="rounded-lg border border-slate-200 px-3 py-1 disabled:opacity-40"
          >
            بعدی
          </button>
        </div>
      </div>
    </div>
  );
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" });
  } catch {
    return String(value);
  }
}
