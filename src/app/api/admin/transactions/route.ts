import { getCurrentUser } from "@/modules/identity/application/current-user";
import { requireRole } from "@/modules/identity/application/guards";
import { apiOk } from "@/app/api/_shared/responses";
import { handleRouteError } from "@/app/api/_shared/route-errors";
import { transactionService } from "@/services/transaction.service";

export async function GET() {
  try {
    const currentUser = await getCurrentUser();
    requireRole(currentUser, ["admin"]);

    const transactions = await transactionService.getAllTransactions();

    return apiOk(transactions);
  } catch (error) {
    return handleRouteError(error);
  }
}
