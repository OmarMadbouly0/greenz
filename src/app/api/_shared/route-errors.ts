import { ApplicationError } from "@/shared/errors/application-error";
import { apiError } from "@/app/api/_shared/responses";

export function handleRouteError(error: unknown) {
  if (error instanceof ApplicationError) {
    return apiError(error.message, error.status);
  }

  console.error(error);

  return apiError("Internal server error.", 500);
}
