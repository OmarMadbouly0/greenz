import type { AuthenticatedUser } from "@/modules/identity/domain/types";
import type { UserRole } from "@/modules/identity/domain/types";
import { error } from "console";

export function requireRole(
  user: AuthenticatedUser,
  roles: UserRole[],
): AuthenticatedUser {
  if (!roles.includes(user.role)) {
    throw error("User does not have the required role.");
  }
  return user;
}
