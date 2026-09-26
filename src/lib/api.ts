import { NextRequest } from "next/server";

export async function parseJson<T>(req: NextRequest): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Invalid JSON payload");
  }
}

export function ok(data: unknown, status = 200) {
  return Response.json(data, { status });
}

export function error(status: number, code: string, message: string, requestId: string) {
  return Response.json(
    {
      error: {
        code,
        message,
        request_id: requestId,
      },
    },
    { status },
  );
}

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function requestId() {
  return crypto.randomUUID();
}
