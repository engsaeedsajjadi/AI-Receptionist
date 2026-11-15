import { AsyncLocalStorage } from "node:async_hooks";
import { AppError } from "@/lib/errors";

export type RequestContext = { requestId: string; traceId: string; businessId?: string; userId?: string };
export const requestContext = new AsyncLocalStorage<RequestContext>();

export function bindTenantContext(businessId: string, userId?: string): void {
  const context = requestContext.getStore();
  if (!context) return;
  if (context.businessId && context.businessId !== businessId)
    throw new AppError(403, "FORBIDDEN", "Tenant context cannot change during a request");
  context.businessId = businessId;
  context.userId = userId;
}

export function assertTenantScope(businessId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(businessId))
    throw new AppError(400, "VALIDATION_ERROR", "Invalid tenant identifier");
  const context = requestContext.getStore();
  if (context?.businessId && context.businessId !== businessId)
    throw new AppError(403, "FORBIDDEN", "Tenant scope mismatch");
}
