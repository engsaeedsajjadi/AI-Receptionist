import { assertTenantScope } from "@/lib/request-context";
import { redisGet, redisSet, redisDel } from "@/lib/redis";

export function tenantCacheKey(businessId: string, namespace: string, key: string): string {
  assertTenantScope(businessId);
  return `tenant:${businessId}:${encodeURIComponent(namespace)}:${encodeURIComponent(key)}`;
}
export async function readTenantCache<T>(businessId: string, namespace: string, key: string): Promise<T | null> {
  const value = await redisGet(tenantCacheKey(businessId, namespace, key));
  return value === null ? null : JSON.parse(value) as T;
}
export async function writeTenantCache(businessId: string, namespace: string, key: string, value: unknown, ttlSeconds = 60): Promise<void> {
  await redisSet(tenantCacheKey(businessId, namespace, key), JSON.stringify(value), ttlSeconds);
}
export async function deleteTenantCache(businessId: string, namespace: string, key: string): Promise<void> {
  await redisDel(tenantCacheKey(businessId, namespace, key));
}
