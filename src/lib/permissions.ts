export const USER_ROLES = ["ADMIN", "MANAGER", "AGENT", "SUPER_ADMIN", "TENANT_ADMIN", "AGENT_OPERATOR", "CALL_OPERATOR", "VIEWER"] as const;
export type UserRole = typeof USER_ROLES[number];
export type Resource = "business" | "users" | "agents" | "calls" | "knowledge" | "crm" | "usage" | "notifications" | "admin" | "automation";
export type Permission = `${Resource}:${"read" | "write"}` | "agents:execute";
const resources: Resource[] = ["business", "users", "agents", "calls", "knowledge", "crm", "usage", "notifications", "admin", "automation"];
const readOnly: Permission[] = resources.filter((r) => r !== "admin" && r !== "users" && r !== "automation").map((r): Permission => `${r}:read`);
const inherited: Record<UserRole, UserRole[]> = {
  VIEWER: [], CALL_OPERATOR: ["VIEWER"], AGENT_OPERATOR: ["VIEWER"],
  AGENT: ["CALL_OPERATOR"], MANAGER: ["AGENT"],
  TENANT_ADMIN: ["MANAGER"], ADMIN: ["TENANT_ADMIN"], SUPER_ADMIN: ["TENANT_ADMIN"],
};
const grants: Record<UserRole, Permission[]> = {
  VIEWER: readOnly,
  CALL_OPERATOR: ["agents:execute", "calls:write", "crm:write", "notifications:write"],
  AGENT_OPERATOR: ["agents:execute", "agents:write", "knowledge:write"],
  AGENT: [], MANAGER: ["knowledge:write", "users:read", "users:write", "usage:write", "automation:read"],
  TENANT_ADMIN: resources.flatMap((r) => [`${r}:read`, `${r}:write`] as Permission[]),
  ADMIN: [], SUPER_ADMIN: [],
};
export function permissionsFor(role: UserRole): Set<Permission> {
  return new Set([...(grants[role] ?? []), ...(inherited[role] ?? []).flatMap((parent) => [...permissionsFor(parent)])]);
}
export function hasPermission(role: UserRole, permission: Permission): boolean {
  return permissionsFor(role).has(permission);
}
// Compatibility for existing routes with ADMIN/MANAGER/AGENT thresholds.
export function hasRole(current: UserRole, minimum: UserRole): boolean {
  if (current === minimum) return true;
  if (minimum === "ADMIN") return ["SUPER_ADMIN", "TENANT_ADMIN"].includes(current);
  return (inherited[current] ?? []).some((parent) => hasRole(parent, minimum));
}
export function permissionForRequest(path: string, method: string): Permission | null {
  const section = path.split("/")[3];
  if (section === "agent" && !["GET", "HEAD", "OPTIONS"].includes(method)) return "agents:execute";
  const mapping: Record<string, Resource> = {
    crm: "crm", automation: "automation", business: "business", users: "users", agents: "agents", agent: "agents", calls: "calls", knowledge: "knowledge",
    customers: "crm", leads: "crm", appointments: "crm", properties: "crm", tools: "crm",
    notifications: "notifications", usage: "usage", admin: "admin",
  };
  const resource = mapping[section];
  if (!resource) return null; // Auth/session routes manage only the current user.
  return `${resource}:${["GET", "HEAD", "OPTIONS"].includes(method) ? "read" : "write"}`;
}
