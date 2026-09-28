import { getCurrentUser } from "@/modules/identity/application/current-user";
import { requireRole } from "@/modules/identity/application/guards";
import { apiOk } from "@/app/api/_shared/responses";
import { handleRouteError } from "@/app/api/_shared/route-errors";
import { walletService } from "@/services/wallet.service";

export async function GET() {
  try {
    const currentUser = await getCurrentUser();
    requireRole(currentUser, ["admin"]);

    const wallets = await walletService.getAllWallets();
    return apiOk(wallets);
  } catch (error) {
    return handleRouteError(error);
  }
}
