import { getCurrentUser } from "@/modules/identity/application/current-user";
import { requireRole } from "@/modules/identity/application/guards";
import { apiOk } from "../../_shared/responses";
import { handleRouteError } from "../../_shared/route-errors";
import { pickupService } from "@/services/pickup.service";
import { pickupListQuerySchema } from "@/services/pickup.schemas";
import { parseInput } from "@/shared/validation/parse-input";

export async function GET(request: Request) {
  try {
    const query = parseInput(
      pickupListQuerySchema,
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const currentUser = await getCurrentUser();
    requireRole(currentUser, ["admin"]);

    const pickups = await pickupService.getAllPickups(query);
    return apiOk(pickups, 200);
  } catch (error) {
    return handleRouteError(error);
  }
}
