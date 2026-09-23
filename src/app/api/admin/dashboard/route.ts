import { getCurrentUser } from "@/modules/identity/application/current-user";
import { requireRole } from "@/modules/identity/application/guards";
import { apiOk } from "../../_shared/responses";
import { handleRouteError } from "../../_shared/route-errors";
import { adminService } from "@/services/admin.service";

export async function GET() {
  try {
    const currentUser = await getCurrentUser();

    await requireRole(currentUser, ["admin"]);

    const dashboard = await adminService.getDashboard();

    return apiOk(dashboard, 200);
  } catch (error) {
    return handleRouteError(error);
  }
}
