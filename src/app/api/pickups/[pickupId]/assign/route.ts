import { pickupService } from "@/services/pickup.service";
import { parseId } from "@/shared/validation/parse-id";
import { getCurrentUser } from "@/modules/identity/application/current-user";
import { requireRole } from "@/modules/identity/application/guards";
import { parseInput } from "@/shared/validation/parse-input";
import { assignPickupToCollectorSchema } from "@/services/pickup.schemas";
import { apiOk } from "@/app/api/_shared/responses";
import { handleRouteError } from "@/app/api/_shared/route-errors";
import { readJsonBody } from "@/app/api/_shared/request-body";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ pickupId: string }> },
) {
  try {
    const currentUser = await getCurrentUser();

    await requireRole(currentUser, ["admin"]);

    const pickupId = parseId((await params).pickupId);

    const body = await readJsonBody(request);

    const input = parseInput(assignPickupToCollectorSchema, body);

    const pickup = await pickupService.assignPickupToCollector(
      input.collectorId,
      pickupId,
    );

    return apiOk(pickup, 200);
  } catch (error) {
    return handleRouteError(error);
  }
}
