import { readJsonBody } from "@/app/api/_shared/request-body";
import { parseInput } from "@/shared/validation/parse-input";
import { loginUserSchema } from "@/services/auth.schemas";
import { authService } from "@/services/auth.service";
import { apiOk } from "@/app/api/_shared/responses";
import { handleRouteError } from "@/app/api/_shared/route-errors";
import { cookies } from "next/headers";

export async function POST(request: Request) {
  try {
    const body = await readJsonBody(request);
    const input = parseInput(loginUserSchema, body);

    const { user, token } = await authService.loginUser(input);

    const cookieStore = await cookies();

    cookieStore.set("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 7,
    });

    return apiOk({ user }, 200);
  } catch (error) {
    return handleRouteError(error);
  }
}
