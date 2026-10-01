import { readJsonBody } from "@/app/api/_shared/request-body";
import { apiOk } from "@/app/api/_shared/responses";
import { handleRouteError } from "@/app/api/_shared/route-errors";
import { getCurrentUser } from "@/modules/identity/application/current-user";
import { requireRole } from "@/modules/identity/application/guards";
import { createWithdrawalSchema } from "@/services/withdrawal.schemas";
import { withdrawalService } from "@/services/withdrawal.service";
import { parseInput } from "@/shared/validation/parse-input";

export async function POST(request: Request) {
  try {
    const currentUser = await getCurrentUser();
    requireRole(currentUser, ["customer"]);

    const body = await readJsonBody(request);
    const input = parseInput(createWithdrawalSchema, body);
    const withdrawal = await withdrawalService.createWithdrawal(
      currentUser.id,
      input,
    );

    return apiOk(withdrawal);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function GET() {
  try {
    const currentUser = await getCurrentUser();
    requireRole(currentUser, ["customer"]);

    const withdrawals = await withdrawalService.getWithdrawalsByUserId(
      currentUser.id,
    );
    return apiOk(withdrawals, 200);
  } catch (error) {
    return handleRouteError(error);
  }
}
