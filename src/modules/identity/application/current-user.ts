import type { AuthenticatedUser } from "@/modules/identity/domain/types";
import { verifyToken } from "@/modules/identity/application/jwt";
import { cookies } from "next/headers";
import { userRepository } from "@/repositories/user.repository";
import { UnauthorizedError } from "@/shared/errors/application-error";

export async function getCurrentUser(): Promise<AuthenticatedUser> {
  const cookieStore = await cookies();
  const token = cookieStore.get("token")?.value;
  if (!token) {
    throw new UnauthorizedError("Authentication required / Token not found.");
  }
  const payload = verifyToken(token);

  const user = await userRepository.findById(payload.userId);
  if (!user) {
    throw new UnauthorizedError("User not found.");
  }
  return {
    id: user.id,
    email: user.email,
    fullName: user.full_name,
    role: user.role,
    lastLoginAt: user.last_login_at,
  };
}
