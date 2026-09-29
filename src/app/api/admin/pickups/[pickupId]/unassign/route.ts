import { pickupService } from "@/services/pickup.service";
import { parseId } from "@/shared/validation/parse-id";
import { getCurrentUser } from "@/modules/identity/application/current-user";
import { requireRole } from "@/modules/identity/application/guards";
import { apiOk } from "@/app/api/_shared/responses";
import { handleRouteError } from "@/app/api/_shared/route-errors";

export async function PATCH(
  _request: Request,
  { params }: { params: Promise<{ pickupId: string }> },
) {
  try {
    const currentUser = await getCurrentUser();

    requireRole(currentUser, ["admin"]);

    const pickupId = parseId((await params).pickupId);
    const pickup = await pickupService.unassignPickupFromCollector(pickupId);

    return apiOk(pickup, 200);
  } catch (error) {
    return handleRouteError(error);
  }
}
