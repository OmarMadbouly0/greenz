import { getCurrentUser } from "@/modules/identity/application/current-user";
import { requireRole } from "@/modules/identity/application/guards";
import { apiOk } from "@/app/api/_shared/responses";
import { handleRouteError } from "@/app/api/_shared/route-errors";
import { walletService } from "@/services/wallet.service";
import { paginationQuerySchema } from "@/shared/validation/pagination.schema";
import { parseInput } from "@/shared/validation/parse-input";

export async function GET(request: Request) {
  try {
    const query = parseInput(
      paginationQuerySchema,
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const currentUser = await getCurrentUser();
    requireRole(currentUser, ["admin"]);

    const wallets = await walletService.getAllWallets(query);
    return apiOk(wallets);
  } catch (error) {
    return handleRouteError(error);
  }
}
