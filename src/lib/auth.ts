import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { User } from "../../generated/prisma/client";
import { cookies } from "next/headers";
import { prisma } from "./prisma";
import { UserRole } from "@/types";

const JWT_SECRET = process.env.JWT_SECRET!;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(
  password: string,
  hashedPassword: string,
): Promise<boolean> {
  return bcrypt.compare(password, hashedPassword);
}

export function generateToken(userId: number): string {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: "7d" });
}

export function verifyToken(token: string): { userId: number } {
  return jwt.verify(token, JWT_SECRET) as { userId: number };
}

export async function getCurrentUser(): Promise<User | null> {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get("token")?.value;
    if (!token) {
      return null;
    }
    const decode = verifyToken(token);
    const userFromDb = await prisma.user.findUnique({
      where: { id: decode.userId },
    });
    if (!userFromDb) {
      return null;
    }
    const { password_hash, ...userWithoutPassword } = userFromDb;
    return userWithoutPassword as User;
  } catch (error) {
    console.error("Error verifying token:", error);
    return null;
  }
}
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
