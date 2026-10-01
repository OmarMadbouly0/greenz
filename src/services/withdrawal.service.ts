import { Prisma } from "@/../generated/prisma/client";
import { withTransaction } from "@/infrastructure/database/prisma";
import { walletRepository } from "@/repositories/wallet.repository";
import { withdrawalRepository } from "@/repositories/withdrawal.repository";
import {
  ConflictError,
  NotFoundError,
} from "@/shared/errors/application-error";
import { pageResult } from "@/shared/pagination";
import {
  CreateWithdrawalInput,
  UpdateWithdrawalStatusInput,
  WithdrawalListQuery,
} from "./withdrawal.schemas";

export const withdrawalService = {
  async createWithdrawal(userId: number, input: CreateWithdrawalInput) {
    const amount = new Prisma.Decimal(input.amount);

    return withTransaction(async (tx) => {
      const customerWallet = await walletRepository.getWalletByUserIdTx(
        tx,
        userId,
      );
      if (!customerWallet) {
        throw new NotFoundError("Wallet not found.");
      }

      await walletRepository.lockWallet(tx, customerWallet.id);
      const wallet = await walletRepository.getWalletByIdTx(
        tx,
        customerWallet.id,
      );
      if (!wallet) {
        throw new NotFoundError("Wallet not found.");
      }
      if (wallet.balance.lessThan(amount)) {
        throw new ConflictError("Insufficient wallet balance.");
      }

      await walletRepository.decrementBalance(tx, wallet.id, amount);
      const withdrawal = await withdrawalRepository.createWithdrawal(
        tx,
        wallet.id,
        amount,
        input.destinationPhone,
      );
      await withdrawalRepository.createWithdrawalTransaction(
        tx,
        wallet.id,
        withdrawal.id,
        "withdrawal",
        amount,
      );

      return withdrawal;
    });
  },

  async getWithdrawalsByUserId(userId: number) {
    const wallet = await walletRepository.getWalletByUserId(userId);
    if (!wallet) {
      throw new NotFoundError("Wallet not found.");
    }
    return withdrawalRepository.getWithdrawalsByWalletId(wallet.id);
  },

  async getAllWithdrawals(query: WithdrawalListQuery) {
    const { items, total } =
      await withdrawalRepository.getAllWithdrawals(query);
    return pageResult(items, total, query.page, query.pageSize);
  },

  async updateWithdrawalStatus(
    adminId: number,
    withdrawalId: number,
    input: UpdateWithdrawalStatusInput,
  ) {
    return withTransaction(async (tx) => {
      await withdrawalRepository.lockWithdrawal(tx, withdrawalId);
      const withdrawal = await withdrawalRepository.getWithdrawalByIdTx(
        tx,
        withdrawalId,
      );
      if (!withdrawal) {
        throw new NotFoundError("Withdrawal not found.");
      }
      if (withdrawal.status !== "pending") {
        throw new ConflictError("Withdrawal has already been handled.");
      }
      if (input.status !== "paid" && input.status !== "cancelled") {
        throw new ConflictError("Withdrawal must move to paid or cancelled.");
      }

      if (input.status === "cancelled") {
        await walletRepository.lockWallet(tx, withdrawal.wallet_id);
        const wallet = await walletRepository.getWalletByIdTx(
          tx,
          withdrawal.wallet_id,
        );
        if (!wallet) {
          throw new NotFoundError("Wallet not found.");
        }
        await walletRepository.incrementBalance(
          tx,
          wallet.id,
          withdrawal.amount,
        );
        await withdrawalRepository.createWithdrawalTransaction(
          tx,
          wallet.id,
          withdrawal.id,
          "refund",
          withdrawal.amount,
        );
      }

      return withdrawalRepository.updateWithdrawalStatus(
        tx,
        withdrawalId,
        adminId,
        input,
      );
    });
  },
};
