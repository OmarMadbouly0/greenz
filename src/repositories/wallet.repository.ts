import { getPrisma } from "@/infrastructure/database/prisma";
export const walletRepository = {
  async createWallet(userId: number, phone: string) {
    return getPrisma().wallet.create({
      data: {
        user_id: userId,
        phone,
      },
    });
  },

  async getWalletByUserId(userId: number) {
    return getPrisma().wallet.findUnique({
      where: { user_id: userId },
    });
  },

  async getWalletTransactions(walletId: number) {
    return getPrisma().walletTransaction.findMany({
      where: { wallet_id: walletId },
      orderBy: { created_at: "desc" },
    });
  },
  async getWalletById(walletId: number) {
    return getPrisma().wallet.findUnique({
      where: { id: walletId },
    });
  },
};
