import { readJsonBody } from "@/app/api/_shared/request-body";
import { registerUserSchema } from "@/services/auth.schemas";
import { authService } from "@/services/auth.service";
import { parseInput } from "@/shared/validation/parse-input";
import { apiOk } from "../../_shared/responses";
import { handleRouteError } from "../../_shared/route-errors";

export async function POST(request: Request) {
  try {
    const body = await readJsonBody(request);
    const input = parseInput(registerUserSchema, body);
    const user = await authService.registerUser(input);
    return apiOk({ user }, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
