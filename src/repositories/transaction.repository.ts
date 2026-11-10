import { getPrisma } from "@/infrastructure/database/prisma";
import { pageArgs } from "@/shared/pagination";
import { PaginationInput } from "@/shared/validation/pagination.schema";

export const transactionRepository = {
  async getTransactionById(transactionId: number) {
    return getPrisma().walletTransaction.findUnique({
      where: {
        id: transactionId,
      },
    });
  },

  async getAllTransactions({ page, pageSize }: PaginationInput) {
    const { skip, take } = pageArgs(page, pageSize);

    const [items, total] = await Promise.all([
      getPrisma().walletTransaction.findMany({
        skip,
        take,
        orderBy: [{ created_at: "desc" }, { id: "desc" }],
      }),
      getPrisma().walletTransaction.count(),
    ]);

    return { items, total };
  },
};
