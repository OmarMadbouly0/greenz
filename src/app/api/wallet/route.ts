import { readJsonBody } from "@/app/api/_shared/request-body";
import { getCurrentUser } from "@/modules/identity/application/current-user";
import { parseInput } from "@/shared/validation/parse-input";
import { createWalletSchema } from "@/services/wallet.schemas";
import { handleRouteError } from "@/app/api/_shared/route-errors";
import { walletService } from "@/services/wallet.service";
import { apiOk } from "../_shared/responses";
import { requireRole } from "@/modules/identity/application/guards";

export async function POST(request: Request) {
  try {
    const body = await readJsonBody(request);
    const input = parseInput(createWalletSchema, body);
    const currentUser = await getCurrentUser();
    await requireRole(currentUser, ["customer"]);
    const wallet = await walletService.createWallet(currentUser.id, input);

    return apiOk(wallet, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function GET() {
  try {
    const currentUser = await getCurrentUser();
    await requireRole(currentUser, ["customer"]);
    const wallet = await walletService.getWalletByUserId(currentUser.id);
    return apiOk(wallet, 200);
  } catch (error) {
    return handleRouteError(error);
  }
}
