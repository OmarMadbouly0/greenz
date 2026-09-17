import { z } from "zod";
export const registerUserSchema = z.object({
  fullName: z.string(),
  email: z.string().email(),
  password: z.string().min(8),
});

export type RegisterInput = z.output<typeof registerUserSchema>;

export const loginUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export type LoginInput = z.output<typeof loginUserSchema>;

export const updateProfileSchema = z.object({
  fullName: z.string().optional(),
});

export type UpdateProfileInput = z.output<typeof updateProfileSchema>;
