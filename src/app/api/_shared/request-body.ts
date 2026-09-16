import { InvalidRequestError } from "@/shared/errors/application-error";
export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new InvalidRequestError("Request body must be valid JSON.");
  }
}
