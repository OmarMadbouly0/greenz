import { getCurrentUser } from "@/modules/identity/application/current-user";
import { requireRole } from "@/modules/identity/application/guards";
import { apiOk } from "../../_shared/responses";
import { handleRouteError } from "../../_shared/route-errors";
import { transactionService } from "@/services/transaction.service";

export async function GET() {
  try {
    const currentUser = await getCurrentUser();

    requireRole(currentUser, ["customer"]);

    const transactions = await transactionService.getWalletTransactionsByUserId(
      currentUser.id,
    );

    return apiOk(transactions, 200);
  } catch (error) {
    return handleRouteError(error);
  }
}
