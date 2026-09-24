import { walletRepository } from "@/repositories/wallet.repository";
import {
  InvalidRequestError,
  NotFoundError,
} from "@/shared/errors/application-error";
import { CreateWalletInput } from "./wallet.schemas";

export const walletService = {
  async createWallet(userId: number, input: CreateWalletInput) {
    const existingWallet = await walletRepository.getWalletByUserId(userId);
    if (existingWallet) {
      throw new InvalidRequestError("Wallet already exists for this user.");
    }
    const wallet = await walletRepository.createWallet(userId, input.phone);
    return wallet;
  },

  async getWalletByUserId(userId: number) {
    const wallet = await walletRepository.getWalletByUserId(userId);
    if (!wallet) {
      throw new NotFoundError("Wallet not found.");
    }
    return wallet;
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

  //admin
  async getWalletById(walletId: number) {
    const wallet = await walletRepository.getWalletById(walletId);
    if (!wallet) {
      throw new NotFoundError("Wallet not found.");
    }
    return wallet;
  },

  async exists(walletId: number) {
    const wallet = await walletRepository.getWalletById(walletId);
    if (!wallet) {
      throw new NotFoundError("Wallet not found.");
    }
  },
};
