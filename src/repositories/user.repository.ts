import { getPrisma } from "@/infrastructure/database/prisma";
import { Prisma } from "../../generated/prisma/client";

export const userRepository = {
  async findById(id: number) {
    return getPrisma().user.findUnique({
      where: { id },
      select: {
        id: true,
        full_name: true,
        email: true,
        role: true,
        last_login_at: true,
      },
    });
  },
  async findByIdTx(userId: number, tx: Prisma.TransactionClient) {
    return tx.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        full_name: true,
        email: true,
        role: true,
        last_login_at: true,
      },
    });
  },
  async emailExists(email: string): Promise<boolean> {
    const user = await getPrisma().user.findUnique({
      where: { email },
      select: { id: true },
    });

    return user !== null;
  },
  async create(
    tx: Prisma.TransactionClient,
    input: {
      fullName: string;
      email: string;
      passwordHash: string;
    },
  ) {
    return tx.user.create({
      data: {
        full_name: input.fullName,
        email: input.email,
        password_hash: input.passwordHash,
        role: "customer",
      },
      select: {
        id: true,
        full_name: true,
        email: true,
        role: true,
      },
    });
  },
  async createCollector(
    tx: Prisma.TransactionClient,
    input: {
      fullName: string;
      email: string;
      passwordHash: string;
    },
  ) {
    return tx.user.create({
      data: {
        full_name: input.fullName,
        email: input.email,
        password_hash: input.passwordHash,
        role: "collector",
      },
      select: {
        id: true,
        full_name: true,
        email: true,
        role: true,
      },
    });
  },

  async findByEmail(email: string) {
    return getPrisma().user.findUnique({
      where: { email },
    });
  },
  async updateLastLogin(userId: number) {
    return getPrisma().user.update({
      where: { id: userId },
      data: { last_login_at: new Date() },
    });
  },
  async getCollectorById(userId: number) {
    return getPrisma().user.findFirst({
      where: {
        id: userId,
        role: "collector",
      },
    });
  },
  async updateProfile(
    tx: Prisma.TransactionClient,
    userId: number,
    input: {
      fullName?: string;
    },
  ) {
    return tx.user.update({
      where: { id: userId },
      data: {
        full_name: input.fullName,
      },
      select: {
        id: true,
        full_name: true,
        email: true,
        role: true,
      },
    });
  },
  async getUsersByRole(role: "customer" | "collector") {
    return getPrisma().user.findMany({
      where: { role },
      select: {
        id: true,
        full_name: true,
        email: true,
        role: true,
      },
    });
  },

  async countUsersByRole(role: "customer" | "collector" | "admin") {
    return getPrisma().user.count({
      where: {
        role,
      },
    });
  },
};
