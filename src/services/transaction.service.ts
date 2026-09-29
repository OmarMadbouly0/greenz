import { NotFoundError } from "@/shared/errors/application-error";
import { transactionRepository } from "@/repositories/transaction.repository";
import { walletRepository } from "@/repositories/wallet.repository";
import { walletService } from "./wallet.service";

export const transactionService = {
  async getTransactionById(transactionId: number) {
    const transaction =
      await transactionRepository.getTransactionById(transactionId);

    if (!transaction) {
      throw new NotFoundError("Transaction not found.");
    }

    return transaction;
  },

  async getAllTransactions() {
    return transactionRepository.getAllTransactions();
  },
  async getWalletTransactions(walletId: number) {
    await walletService.exists(walletId);
    const transactions = await walletRepository.getWalletTransactions(walletId);
    return transactions;
  },
  async getWalletTransactionsByUserId(userId: number) {
    const wallet = await walletService.getWalletByUserId(userId);
    const transactions = await walletRepository.getWalletTransactions(
      wallet.id,
    );
    return transactions;
  },
};
