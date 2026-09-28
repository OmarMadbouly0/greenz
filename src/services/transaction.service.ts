import { NotFoundError } from "@/shared/errors/application-error";
import { transactionRepository } from "@/repositories/transaction.repository";

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
};
