import { z } from "zod";
import { InvalidRequestError } from "../errors/application-error";

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const errors: Record<string, string> = Object.create(null);
    for (const issue of result.error.issues) {
      const field = issue.path.join(".") || "input";
      errors[field] ??= issue.message;
    }

    throw new InvalidRequestError("Invalid input", errors);
  }
  return result.data;
}
