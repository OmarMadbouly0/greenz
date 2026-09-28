import { getCurrentUser } from "@/modules/identity/application/current-user";
import { requireRole } from "@/modules/identity/application/guards";
import { apiOk } from "@/app/api/_shared/responses";
import { handleRouteError } from "@/app/api/_shared/route-errors";
import { walletService } from "@/services/wallet.service";
import { parseId } from "@/shared/validation/parse-id";

export async function GET(
  _request: Request,
  {
    params,
  }: {
    params: Promise<{ walletId: string }>;
  },
) {
  try {
    const currentUser = await getCurrentUser();
    requireRole(currentUser, ["admin"]);
    const walletId = parseId((await params).walletId);

    const wallet = await walletService.getWalletById(walletId);
    return apiOk(wallet);
  } catch (error) {
    return handleRouteError(error);
  }
}
