import type { AuthenticatedUser } from "@/modules/identity/domain/types";
import { verifyToken } from "@/modules/identity/application/jwt";
import { cookies } from "next/headers";
import { userRepository } from "@/repositories/user.repository";

export async function getCurrentUser(): Promise<AuthenticatedUser> {
  let payload: { userId: number };
  const cookieStore = await cookies();
  const token = cookieStore.get("token")?.value;
  if (!token) {
    throw new Error("No token found in cookies.");
  }
  try {
    payload = verifyToken(token);
  } catch {
    throw new Error("Invalid or expired token.");
  }

  const user = await userRepository.findById(payload.userId);
  if (!user) {
    throw new Error("User not found.");
  }
  return {
    id: user.id,
    email: user.email,
    fullName: user.full_name,
    role: user.role,
    lastLoginAt: user.last_login_at,
  };
}
