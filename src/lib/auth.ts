import { User } from "@/../generated/prisma/client";
import { cookies } from "next/headers";
import { getPrisma } from "@/infrastructure/database/prisma";
import { UserRole } from "@/modules/identity/domain/types";
import { verifyToken } from "@/modules/identity/application/jwt";

export function checkUserPermission(
  user: User,
  requiredRole: UserRole,
): boolean {
  const roleHierarchy = {
    customer: 1,
    collector: 2,
    admin: 3,
  };

  return roleHierarchy[user.role] >= roleHierarchy[requiredRole];
}
