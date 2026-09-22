import { handleRouteError } from "@/app/api/_shared/route-errors";
import { apiOk } from "../../_shared/responses";
import { pickupService } from "@/services/pickup.service";
import { parseId } from "@/shared/validation/parse-id";
import { getCurrentUser } from "@/modules/identity/application/current-user";
import { requireRole } from "@/modules/identity/application/guards";
import { readJsonBody } from "../../_shared/request-body";
import { parseInput } from "@/shared/validation/parse-input";
import { updatePickupStatusSchema } from "@/services/pickup.schemas";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ pickupId: string }> },
) {
  try {
    const currentUser = await getCurrentUser();

    await requireRole(currentUser, ["customer", "collector"]);

    const pickupId = parseId((await params).pickupId);

    const pickup = await pickupService.getPickupById(
      currentUser.id,
      currentUser.role,
      pickupId,
    );
    return apiOk(pickup);
  } catch (error) {
    return handleRouteError(error);
  }
}
export async function DELETE({
  params,
}: {
  params: Promise<{ pickupId: string }>;
}) {
  try {
    const currentUser = await getCurrentUser();
    await requireRole(currentUser, ["customer"]);
    const pickupId = parseId((await params).pickupId);
    const pickup = await pickupService.cancelPickup(currentUser.id, pickupId);
    return apiOk(pickup);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ pickupId: string }> },
) {
  try {
    const currentCollector = await getCurrentUser();

    await requireRole(currentCollector, ["collector"]);

    const pickupId = parseId((await params).pickupId);

    const body = await readJsonBody(request);

    const input = parseInput(updatePickupStatusSchema, body);

    const pickup = await pickupService.updatePickupStatus(
      currentCollector.id,
      pickupId,
      input,
    );

    return apiOk(pickup, 200);
  } catch (error) {
    return handleRouteError(error);
  }
}
