import { readJsonBody } from "@/app/api/_shared/request-body";
import { apiOk } from "@/app/api/_shared/responses";
import { handleRouteError } from "@/app/api/_shared/route-errors";
import { getCurrentUser } from "@/modules/identity/application/current-user";
import { requireRole } from "@/modules/identity/application/guards";
import { updateWithdrawalStatusSchema } from "@/services/withdrawal.schemas";
import { withdrawalService } from "@/services/withdrawal.service";
import { parseId } from "@/shared/validation/parse-id";
import { parseInput } from "@/shared/validation/parse-input";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ withdrawalId: string }> },
) {
  try {
    const currentUser = await getCurrentUser();
    requireRole(currentUser, ["admin"]);

    const withdrawalId = parseId((await params).withdrawalId);
    const body = await readJsonBody(request);
    const input = parseInput(updateWithdrawalStatusSchema, body);
    const withdrawal = await withdrawalService.updateWithdrawalStatus(
      currentUser.id,
      withdrawalId,
      input,
    );

    return apiOk(withdrawal, 200);
  } catch (error) {
    return handleRouteError(error);
  }
}
