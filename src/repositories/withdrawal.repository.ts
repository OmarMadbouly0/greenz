import { Prisma } from "@/../generated/prisma/client";
import { getPrisma } from "@/infrastructure/database/prisma";
import {
  UpdateWithdrawalStatusInput,
  WithdrawalListQuery,
} from "@/services/withdrawal.schemas";
import { pageArgs } from "@/shared/pagination";

export const withdrawalRepository = {
  async lockWithdrawal(tx: Prisma.TransactionClient, withdrawalId: number) {
    await tx.$queryRaw`
      SELECT id
      FROM withdrawal_requests
      WHERE id = ${withdrawalId}
      FOR UPDATE
    `;
  },

  async getWithdrawalByIdTx(
    tx: Prisma.TransactionClient,
    withdrawalId: number,
  ) {
    return tx.withdrawalRequest.findUnique({
      where: { id: withdrawalId },
    });
  },

  async createWithdrawal(
    tx: Prisma.TransactionClient,
    walletId: number,
    amount: Prisma.Decimal,
    destinationPhone: string,
  ) {
    return tx.withdrawalRequest.create({
      data: {
        wallet_id: walletId,
        amount,
        destination_phone: destinationPhone,
      },
    });
  },

  async createWithdrawalTransaction(
    tx: Prisma.TransactionClient,
    walletId: number,
    withdrawalId: number,
    type: "withdrawal" | "refund",
    amount: Prisma.Decimal,
  ) {
    return tx.walletTransaction.create({
      data: {
        wallet_id: walletId,
        withdrawal_id: withdrawalId,
        type,
        amount,
      },
    });
  },

  async updateWithdrawalStatus(
    tx: Prisma.TransactionClient,
    withdrawalId: number,
    adminId: number,
    { status }: UpdateWithdrawalStatusInput,
  ) {
    return tx.withdrawalRequest.update({
      where: { id: withdrawalId, status: "pending" },
      data: {
        status,
        admin_id: adminId,
        paid_at: status === "paid" ? new Date() : undefined,
        cancelled_at: status === "cancelled" ? new Date() : undefined,
      },
    });
  },

  async getWithdrawalsByWalletId(walletId: number) {
    return getPrisma().withdrawalRequest.findMany({
      where: { wallet_id: walletId },
      orderBy: { id: "desc" },
    });
  },

  async getAllWithdrawals({ page, pageSize, status }: WithdrawalListQuery) {
    const { skip, take } = pageArgs(page, pageSize);
    const where = status !== undefined ? { status: status } : {};
    const [items, total] = await Promise.all([
      getPrisma().withdrawalRequest.findMany({
        where,
        skip,
        take,
        orderBy: { id: "desc" },
        include: {
          wallet: {
            select: {
              id: true,
              phone: true,
              balance: true,
              user: { select: { id: true, full_name: true, email: true } },
            },
          },
        },
      }),
      getPrisma().withdrawalRequest.count({ where }),
    ]);

    return { items, total };
  },
};
