import { getCurrentUser } from "@/modules/identity/application/current-user";
import { requireRole } from "@/modules/identity/application/guards";
import { apiOk } from "../../../_shared/responses";
import { handleRouteError } from "../../../_shared/route-errors";
import { adminService } from "@/services/admin.service";
import { authService } from "@/services/auth.service";
import { readJsonBody } from "../../../_shared/request-body";
import { parseInput } from "@/shared/validation/parse-input";
import { registerCollectorSchema } from "@/services/collector.schemas";
import { paginationQuerySchema } from "@/shared/validation/pagination.schema";

export async function GET(request: Request) {
  try {
    const currentUser = await getCurrentUser();
    requireRole(currentUser, ["admin"]);
    const query = parseInput(
      paginationQuerySchema,
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const collectors = await adminService.getUsersByRole("collector", query);
    return apiOk(collectors, 200);
  } catch (error) {
    return handleRouteError(error);
  }
}
export async function POST(request: Request) {
  try {
    const currentUser = await getCurrentUser();
    requireRole(currentUser, ["admin"]);

    const body = await readJsonBody(request);
    const input = parseInput(registerCollectorSchema, body);
    const collector = await authService.registerUser(input, "collector");
    return apiOk(collector, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
