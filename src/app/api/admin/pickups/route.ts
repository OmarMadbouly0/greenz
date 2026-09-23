import { getCurrentUser } from "@/modules/identity/application/current-user";
import { requireRole } from "@/modules/identity/application/guards";
import { apiOk } from "../../_shared/responses";
import { handleRouteError } from "../../_shared/route-errors";
import { pickupService } from "@/services/pickup.service";
export async function GET() {
  try {
    const currentUser = await getCurrentUser();
    await requireRole(currentUser, ["admin"]);
    const pickups = await pickupService.getPickups(currentUser.id, "admin");
    return apiOk(pickups, 200);
  } catch (error) {
    return handleRouteError(error);
  }
}
