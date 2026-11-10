import { getCurrentUser } from "@/modules/identity/application/current-user";
import { requireRole } from "@/modules/identity/application/guards";
import { apiOk } from "@/app/api/_shared/responses";
import { handleRouteError } from "@/app/api/_shared/route-errors";
import { transactionService } from "@/services/transaction.service";
import { paginationQuerySchema } from "@/shared/validation/pagination.schema";
import { parseInput } from "@/shared/validation/parse-input";

export async function GET(request: Request) {
  try {
    const currentUser = await getCurrentUser();
    requireRole(currentUser, ["admin"]);

    const query = parseInput(
      paginationQuerySchema,
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const transactions = await transactionService.getAllTransactions(query);

    return apiOk(transactions);
  } catch (error) {
    return handleRouteError(error);
  }
}
