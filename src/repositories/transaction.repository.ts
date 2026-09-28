import { getPrisma } from "@/infrastructure/database/prisma";

export const transactionRepository = {
  async getTransactionById(transactionId: number) {
    return getPrisma().walletTransaction.findUnique({
      where: {
        id: transactionId,
      },
    });
  },

  async getAllTransactions() {
    return getPrisma().walletTransaction.findMany({
      orderBy: {
        created_at: "desc",
      },
    });
  },
};
