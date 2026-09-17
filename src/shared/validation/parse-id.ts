import { InvalidRequestError } from "@/shared/errors/application-error";

const MAX_INT4 = 2147483647;

export function parseId(id: string): number {
  if (!/^\d+$/.test(id)) {
    throw new InvalidRequestError("Invalid id.");
  }

  const parsed = Number.parseInt(id, 10);

  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_INT4) {
    throw new InvalidRequestError("Invalid id.");
  }

  return parsed;
}
