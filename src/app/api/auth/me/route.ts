import { getCurrentUser } from "@/modules/identity/application/current-user";
import { apiOk } from "@/app/api/_shared/responses";
import { handleRouteError } from "@/app/api/_shared/route-errors";
import { readJsonBody } from "../../_shared/request-body";
import { parseInput } from "@/shared/validation/parse-input";
import { updateProfileSchema } from "@/services/auth.schemas";
import { authService } from "@/services/auth.service";

export async function GET() {
  try {
    const user = await getCurrentUser();
    return apiOk({ user }, 200);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const currentUser = await getCurrentUser();
    const body = await readJsonBody(request);
    const input = parseInput(updateProfileSchema, body);
    const updatedUser = await authService.updateUserProfile(
      currentUser.id,
      input,
    );
    return apiOk({ user: updatedUser }, 200);
  } catch (error) {
    return handleRouteError(error);
  }
}
