import { pickupService } from "@/services/pickup.service";
import { apiOk } from "@/app/api/_shared/responses";
import { handleRouteError } from "@/app/api/_shared/route-errors";
import { requireRole } from "@/modules/identity/application/guards";
import { getCurrentUser } from "@/modules/identity/application/current-user";
import { readJsonBody } from "../_shared/request-body";
import { createPickupSchema } from "@/services/pickup.schemas";
import { parseInput } from "@/shared/validation/parse-input";

export async function GET() {
  try {
    const currentUser = await getCurrentUser();
    await requireRole(currentUser, ["customer", "collector"]);

    const pickups = await pickupService.getPickups(
      currentUser.id,
      currentUser.role ,
    );

    return apiOk(pickups, 200);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    const currentUser = await getCurrentUser();
    await requireRole(currentUser, ["customer"]);

    const body = await readJsonBody(request);
    const input = parseInput(createPickupSchema, body);

    const pickup = await pickupService.createPickup(currentUser.id, input);

    return apiOk(pickup, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
