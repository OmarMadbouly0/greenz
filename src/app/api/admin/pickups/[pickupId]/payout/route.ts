import { pickupService } from "@/services/pickup.service";
import { updatePayoutStatusSchema } from "@/services/pickup.schemas";
import { getCurrentUser } from "@/modules/identity/application/current-user";
import { requireRole } from "@/modules/identity/application/guards";
import { parseId } from "@/shared/validation/parse-id";
import { parseInput } from "@/shared/validation/parse-input";
import { readJsonBody } from "@/app/api/_shared/request-body";
import { apiOk } from "@/app/api/_shared/responses";
import { handleRouteError } from "@/app/api/_shared/route-errors";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ pickupId: string }> },
) {
  try {
    const currentUser = await getCurrentUser();

    await requireRole(currentUser, ["admin"]);

    const pickupId = parseId((await params).pickupId);

    const body = await readJsonBody(request);

    const input = parseInput(updatePayoutStatusSchema, body);

    const pickup = await pickupService.updatePayoutStatus(pickupId, input);

    return apiOk(pickup, 200);
  } catch (error) {
    return handleRouteError(error);
  }
}
