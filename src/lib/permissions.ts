export type UserRole = "ADMIN" | "MANAGER" | "AGENT";

const roleRank: Record<UserRole, number> = {
  AGENT: 1,
  MANAGER: 2,
  ADMIN: 3,
};

export function hasRole(current: UserRole, minimum: UserRole) {
  return roleRank[current] >= roleRank[minimum];
}
