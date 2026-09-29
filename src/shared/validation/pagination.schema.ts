import { z } from "zod";

export const paginationQuerySchema = z.object({
  page: z.coerce
    .number("Page must be a number.")
    .int("Page must be an integer.")
    .min(1, "Page must be at least 1.")
    .default(1),

  pageSize: z.coerce
    .number("Page size must be a number.")
    .int("Page size must be an integer.")
    .min(1, "Page size must be at least 1.")
    .max(100, "Page size must not exceed 100.")
    .default(20),
});

export type PaginationInput = z.infer<typeof paginationQuerySchema>;
