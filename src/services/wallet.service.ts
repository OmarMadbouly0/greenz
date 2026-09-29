import { walletRepository } from "@/repositories/wallet.repository";
import {
  ConflictError,
  NotFoundError,
} from "@/shared/errors/application-error";
import { CreateWalletInput } from "./wallet.schemas";
import { PaginationInput } from "@/shared/validation/pagination.schema";
import { pageResult } from "@/shared/pagination";

export const walletService = {
  async createWallet(userId: number, input: CreateWalletInput) {
    const existingWallet = await walletRepository.getWalletByUserId(userId);
    if (existingWallet) {
      throw new ConflictError("Wallet already exists for this user.");
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
  async getAllWallets(pagination: PaginationInput) {
    const { items, total } = await walletRepository.getAllWallets(pagination);

    return pageResult(items, total, pagination.page, pagination.pageSize);
  },
};
