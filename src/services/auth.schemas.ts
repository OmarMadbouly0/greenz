import { z } from "zod";
export const registerSchema = z.object({
  fullName: z.string(),
  email: z.string().email(),
  password: z.string().min(8),
});

export type RegisterInput = z.output<typeof registerSchema>;
