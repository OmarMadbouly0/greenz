import { z } from "zod";
import { InvalidRequestError } from "../errors/application-error";

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new InvalidRequestError("Invalid input");
  }
  return result.data;
}
