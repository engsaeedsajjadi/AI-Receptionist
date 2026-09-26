import { NextRequest } from "next/server";
import { z } from "zod";
import { AppError, type ErrorCode, toErrorPayload } from "@/lib/errors";
import { logError } from "@/lib/logger";

// Backwards-compatible alias: existing routes throw `new ApiError(status, code, message)`.
export { AppError as ApiError };
export { AppError } from "@/lib/errors";

export async function parseJson<T>(req: NextRequest): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new AppError(400, "INVALID_JSON", "Invalid JSON payload");
  }
}

/**
 * Map a Postgres unique violation (23505) to a typed 409 by constraint name;
 * rethrows anything else untouched. Pre-insert SELECT checks have a race
 * window, so the unique index is the real guard — this keeps the loser on a
 * clean 409 instead of a 500.
 */
export function mapUniqueViolation(
  err: unknown,
  byConstraint: Record<string, { code: ErrorCode; message: string }>,
): never {
  const pg = err as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  const code = pg?.code ?? pg?.cause?.code;
  const constraint = pg?.constraint ?? pg?.cause?.constraint;
  if (code === "23505" && constraint && byConstraint[constraint]) {
    const mapped = byConstraint[constraint];
    throw new AppError(409, mapped.code, mapped.message);
  }
  throw err;
}

export function parseWith<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
      code: i.code,
    }));
    throw new AppError(400, "VALIDATION_ERROR", "Validation failed", details);
  }
  return parsed.data;
}

export async function parseJsonWith<T>(req: NextRequest, schema: z.ZodType<T>): Promise<T> {
  const body = await parseJson<unknown>(req);
  return parseWith(schema, body);
}

export function ok(data: unknown, status = 200, headers?: Record<string, string>) {
  return Response.json(data, { status, headers });
}

export function error(status: number, code: string, message: string, requestId: string) {
  return Response.json(
    {
      success: false,
      error: { code, message, requestId },
    },
    { status },
  );
}

export function requestId(): string {
  return crypto.randomUUID();
}

const PAGINATION_DEFAULT_LIMIT = 20;
const PAGINATION_MAX_LIMIT = 100;

export function parsePagination(req: NextRequest): { page: number; limit: number; offset: number } {
  const page = Math.max(Number(req.nextUrl.searchParams.get("page") ?? "1") || 1, 1);
  const limit = Math.min(
    Math.max(Number(req.nextUrl.searchParams.get("limit") ?? String(PAGINATION_DEFAULT_LIMIT)) || PAGINATION_DEFAULT_LIMIT, 1),
    PAGINATION_MAX_LIMIT,
  );
  return { page, limit, offset: (page - 1) * limit };
}

export function paginated<T>(items: T[], page: number, limit: number, total: number) {
  return {
    data: items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(Math.ceil(total / limit), 1),
    },
  };
}

export async function handleApiError(err: unknown, rid: string, context?: Record<string, unknown>) {
  const { status, body, headers } = toErrorPayload(err, rid);
  if (status >= 500) {
    logError("API request failed", { requestId: rid, status: String(status), errorCode: body.error.code, error: err, ...(context ?? {}) });
  }
  return Response.json(body, { status, headers });
}
