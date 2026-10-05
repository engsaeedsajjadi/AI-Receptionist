import { NextRequest } from "next/server";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { AppError } from "@/lib/errors";

/**
 * Cursor (keyset) pagination.
 *
 * Offset pagination re-scans everything before the requested page and silently
 * skips or repeats rows when data changes between requests. Every tenant list
 * endpoint therefore exposes a **stable keyset cursor** on top of its existing
 * offset parameters:
 *
 *   GET /api/v1/<resource>?limit=50&cursor=<nextCursor from the previous page>
 *
 * The cursor encodes the last row's `(created_at, id)` — the total order the
 * endpoints sort by (`created_at DESC, id DESC`). It is opaque (base64url) but
 * **not** trusted: it is validated and then used only *in addition to* the
 * caller's tenant predicate, so a forged or cross-tenant cursor can never widen
 * a result set, it can only move the window inside the caller's own tenant.
 *
 * Responses always carry `data`, `nextCursor` and `hasMore`. The legacy
 * `pagination` block is still returned so existing clients keep working.
 */

export const PAGINATION_DEFAULT_LIMIT = 20;
export const PAGINATION_MAX_LIMIT = 100;

export type Cursor = { createdAt: Date; id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(row: { createdAt: Date | string; id: string }): string {
  const createdAt = row.createdAt instanceof Date ? row.createdAt.toISOString() : new Date(row.createdAt).toISOString();
  return Buffer.from(JSON.stringify({ t: createdAt, id: row.id }), "utf8").toString("base64url");
}

/** Malformed cursors are a client error (400), never silently ignored. */
export function decodeCursor(value: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new AppError(400, "VALIDATION_ERROR", "Invalid cursor");
  }
  const candidate = parsed as { t?: unknown; id?: unknown };
  if (typeof candidate?.t !== "string" || typeof candidate?.id !== "string" || !UUID.test(candidate.id)) {
    throw new AppError(400, "VALIDATION_ERROR", "Invalid cursor");
  }
  const createdAt = new Date(candidate.t);
  if (Number.isNaN(createdAt.getTime())) throw new AppError(400, "VALIDATION_ERROR", "Invalid cursor");
  return { createdAt, id: candidate.id };
}

export type ListWindow = {
  limit: number;
  /** Present when the caller asked for the next keyset window. */
  cursor: Cursor | null;
  /** Legacy offset window, still honoured. */
  page: number;
  offset: number;
};

/**
 * Parses `limit`, `cursor` and the legacy `page` parameters.
 * `cursor` wins when both are supplied (it is the stable one).
 */
export function parseListWindow(req: NextRequest, defaults: { limit?: number; maxLimit?: number } = {}): ListWindow {
  const defaultLimit = defaults.limit ?? PAGINATION_DEFAULT_LIMIT;
  const maxLimit = defaults.maxLimit ?? PAGINATION_MAX_LIMIT;
  const rawLimit = Number(req.nextUrl.searchParams.get("limit") ?? defaultLimit);
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : defaultLimit, 1), maxLimit);
  const rawCursor = req.nextUrl.searchParams.get("cursor");
  const page = Math.max(Number(req.nextUrl.searchParams.get("page") ?? "1") || 1, 1);
  return { limit, cursor: rawCursor ? decodeCursor(rawCursor) : null, page, offset: (page - 1) * limit };
}

type SortableColumn = Parameters<typeof sql>[0] extends never ? never : unknown;

/**
 * `(created_at, id) < (cursor.created_at, cursor.id)` with the same collation
 * the endpoints sort by, so the window is stable across pages and index-backed
 * by the tenant-leading `(business_id, created_at)` indexes.
 */
export function keysetCondition(
  columns: { createdAt: SortableColumn; id: SortableColumn },
  cursor: Cursor,
): SQL {
  return sql`(${columns.createdAt} < ${cursor.createdAt} OR (${columns.createdAt} = ${cursor.createdAt} AND ${columns.id} < ${cursor.id}::uuid))`;
}

export type CursorPage<T> = {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
  pagination: { page: number; limit: number; total?: number; totalPages?: number };
};

/**
 * Builds the response for either window kind.
 *
 * `rows` must contain at most `limit + 1` rows when the caller fetched an extra
 * row to detect `hasMore` (keyset mode); pass `extra: true` and the surplus row
 * is dropped here so callers cannot accidentally leak it to the client.
 */
export function cursorPage<T extends { id: string; createdAt: Date | string }>(input: {
  rows: T[];
  limit: number;
  page?: number;
  extra?: boolean;
  total?: number;
}): CursorPage<T> {
  const { rows, limit, page = 1 } = input;
  const hasMore = input.extra ? rows.length > limit : false;
  const data = input.extra ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  const total = input.total;
  return {
    data,
    nextCursor: hasMore && last ? encodeCursor(last) : null,
    hasMore,
    pagination: {
      page,
      limit,
      ...(typeof total === "number" ? { total, totalPages: Math.max(Math.ceil(total / limit), 1) } : {}),
    },
  };
}
