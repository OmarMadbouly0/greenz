import { getPrisma } from "@/infrastructure/database/prisma";
import { pageArgs } from "@/shared/pagination";
import { PaginationInput } from "@/shared/validation/pagination.schema";
import { Prisma } from "../../generated/prisma/client";
export const walletRepository = {
  async lockWallet(tx: Prisma.TransactionClient, walletId: number) {
    await tx.$queryRaw`
      SELECT id
      FROM wallets
      WHERE id = ${walletId}
      FOR UPDATE
    `;
  },

  async getWalletByIdTx(tx: Prisma.TransactionClient, walletId: number) {
    return tx.wallet.findUnique({
      where: { id: walletId },
    });
  },

  async decrementBalance(
    tx: Prisma.TransactionClient,
    walletId: number,
    amount: Prisma.Decimal,
  ) {
    return tx.wallet.update({
      where: { id: walletId },
      data: { balance: { decrement: amount } },
    });
  },

  async incrementBalance(
    tx: Prisma.TransactionClient,
    walletId: number,
    amount: Prisma.Decimal,
  ) {
    return tx.wallet.update({
      where: { id: walletId },
      data: { balance: { increment: amount } },
    });
  },

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
  async getWalletByUserIdTx(tx: Prisma.TransactionClient, userId: number) {
    return tx.wallet.findUnique({
      where: {
        user_id: userId,
      },
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
  async getAllWallets({ page, pageSize }: PaginationInput) {
    const { skip, take } = pageArgs(page, pageSize);

    const [items, total] = await Promise.all([
      getPrisma().wallet.findMany({
        skip,
        take,
        orderBy: {
          id: "desc",
        },
      }),

      getPrisma().wallet.count(),
    ]);

    return {
      items,
      total,
    };
  },
};
