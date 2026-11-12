import { NotFoundError } from "@/shared/errors/application-error";
import { transactionRepository } from "@/repositories/transaction.repository";
import { walletRepository } from "@/repositories/wallet.repository";
import { walletService } from "./wallet.service";
import { pageResult } from "@/shared/pagination";
import { PaginationInput } from "@/shared/validation/pagination.schema";

export const transactionService = {
  async getTransactionById(transactionId: number) {
    const transaction =
      await transactionRepository.getTransactionById(transactionId);

    if (!transaction) {
      throw new NotFoundError("Transaction not found.");
    }

    return transaction;
  },

  async getAllTransactions(pagination: PaginationInput) {
    const { items, total } =
      await transactionRepository.getAllTransactions(pagination);

    return pageResult(items, total, pagination.page, pagination.pageSize);
  },
  async getWalletTransactions(walletId: number, pagination: PaginationInput) {
    await walletService.exists(walletId);
    const { items, total } = await walletRepository.getWalletTransactions(
      walletId,
      pagination,
    );
    return pageResult(items, total, pagination.page, pagination.pageSize);
  },
  async getWalletTransactionsByUserId(
    userId: number,
    pagination: PaginationInput,
  ) {
    const wallet = await walletService.getWalletByUserId(userId);
    const { items, total } = await walletRepository.getWalletTransactions(
      wallet.id,
      pagination,
    );
    return pageResult(items, total, pagination.page, pagination.pageSize);
  },
};
