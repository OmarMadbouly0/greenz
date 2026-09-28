import { getCurrentUser } from "@/modules/identity/application/current-user";
import { requireRole } from "@/modules/identity/application/guards";
import { apiOk } from "../../../_shared/responses";
import { handleRouteError } from "../../../_shared/route-errors";
import { adminService } from "@/services/admin.service";

export async function GET() {
  try {
    const currentUser = await getCurrentUser();
    requireRole(currentUser, ["admin"]);
    const customers = await adminService.getUsersByRole("customer");
    return apiOk(customers, 200);
  } catch (error) {
    return handleRouteError(error);
  }
}
