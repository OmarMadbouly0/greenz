import type { AuthenticatedUser } from "@/modules/identity/domain/types";
import type { UserRole } from "@/modules/identity/domain/types";
import { ForbiddenError } from "@/shared/errors/application-error";

export function requireRole(
  user: AuthenticatedUser,
  roles: UserRole[],
): AuthenticatedUser {
  if (!roles.includes(user.role)) {
    throw new ForbiddenError("User does not have the required role.");
  }
  return user;
}
