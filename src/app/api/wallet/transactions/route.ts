import { getCurrentUser } from "@/modules/identity/application/current-user";
import { requireRole } from "@/modules/identity/application/guards";
import { apiOk } from "../../_shared/responses";
import { handleRouteError } from "../../_shared/route-errors";
import { walletService } from "@/services/wallet.service";

export async function GET() {
  try {
    const currentUser = await getCurrentUser();

    await requireRole(currentUser, ["customer"]);

    const transactions = await walletService.getWalletTransactionsByUserId(
      currentUser.id,
    );

    return apiOk(transactions, 200);
  } catch (error) {
    return handleRouteError(error);
  }
}
