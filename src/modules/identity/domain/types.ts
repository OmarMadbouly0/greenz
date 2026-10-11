export type UserRole = "customer" | "collector" | "admin";

export type AuthenticatedUser = {
  id: number;
  email: string;
  fullName: string;
  role: UserRole;
};

export const materialUnit = ["kg", "g", "l", "ml", "piece"] as const;
