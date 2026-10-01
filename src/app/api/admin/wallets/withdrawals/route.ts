import { apiOk } from "@/app/api/_shared/responses";
import { handleRouteError } from "@/app/api/_shared/route-errors";
import { getCurrentUser } from "@/modules/identity/application/current-user";
import { requireRole } from "@/modules/identity/application/guards";
import { withdrawalListQuerySchema } from "@/services/withdrawal.schemas";
import { withdrawalService } from "@/services/withdrawal.service";
import { parseInput } from "@/shared/validation/parse-input";

export async function GET(request: Request) {
  try {
    const currentUser = await getCurrentUser();
    requireRole(currentUser, ["admin"]);

    const query = parseInput(
      withdrawalListQuerySchema,
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const withdrawals = await withdrawalService.getAllWithdrawals(query);

    return apiOk(withdrawals, 200);
  } catch (error) {
    return handleRouteError(error);
  }
}
