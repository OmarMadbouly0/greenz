import { getCurrentUser } from "@/modules/identity/application/current-user";
import { requireRole } from "@/modules/identity/application/guards";
import { apiOk } from "@/app/api/_shared/responses";
import { handleRouteError } from "@/app/api/_shared/route-errors";
import { transactionService } from "@/services/transaction.service";
import { parseId } from "@/shared/validation/parse-id";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ transactionId: string }> },
) {
  try {
    const currentUser = await getCurrentUser();
    requireRole(currentUser, ["admin"]);

    const transactionId = parseId((await params).transactionId);

    const transaction =
      await transactionService.getTransactionById(transactionId);

    return apiOk(transaction);
  } catch (error) {
    return handleRouteError(error);
  }
}
