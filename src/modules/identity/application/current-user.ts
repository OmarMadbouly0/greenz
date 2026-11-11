import type { AuthenticatedUser } from "@/modules/identity/domain/types";
import { verifyToken } from "@/modules/identity/application/jwt";
import { cookies } from "next/headers";
import { NextRequest } from "next/server";
import { userRepository } from "@/repositories/user.repository";
import { UnauthorizedError } from "@/shared/errors/application-error";

export async function getCurrentUser(request?: Request): Promise<AuthenticatedUser> {
  const cookieStore = request
    ? new NextRequest(request.url, { headers: request.headers }).cookies
    : await cookies();
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
  };
}
