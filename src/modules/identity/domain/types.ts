export type UserRole = "customer" | "collector" | "admin";

export type AuthenticatedUser = {
  id: number;
  email: string;
  fullName: string;
  role: UserRole;
  lastLoginAt: Date | null;
};
