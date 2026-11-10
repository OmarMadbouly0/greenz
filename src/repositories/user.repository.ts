import { getPrisma } from "@/infrastructure/database/prisma";
import { Prisma } from "../../generated/prisma/client";
import { pageArgs } from "@/shared/pagination";
import { PaginationInput } from "@/shared/validation/pagination.schema";

export const userRepository = {
  async findById(id: number) {
    return getPrisma().user.findUnique({
      where: { id },
      select: {
        id: true,
        full_name: true,
        email: true,
        role: true,
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
  async lockEmail(tx: Prisma.TransactionClient, email: string) {
    await tx.$queryRaw`
      SELECT 1
      FROM pg_advisory_xact_lock(hashtextextended(${`user-email:${email}`}, 0))
    `;
  },
  async emailExistsTx(tx: Prisma.TransactionClient, email: string) {
    const user = await tx.user.findUnique({
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
      role: "customer" | "collector";
    },
  ) {
    return tx.user.create({
      data: {
        full_name: input.fullName,
        email: input.email,
        password_hash: input.passwordHash,
        role: input.role,
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
  async getCollectorById(tx: Prisma.TransactionClient, userId: number) {
    return tx.user.findFirst({
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
  async getUsersByRole(
    role: "customer" | "collector",
    { page, pageSize }: PaginationInput,
  ) {
    const { skip, take } = pageArgs(page, pageSize);
    const where = { role };

    const [items, total] = await Promise.all([
      getPrisma().user.findMany({
        where,
        skip,
        take,
        orderBy: { id: "desc" },
        select: {
          id: true,
          full_name: true,
          email: true,
          role: true,
        },
      }),
      getPrisma().user.count({ where }),
    ]);

    return { items, total };
  },

  async countUsersByRole(role: "customer" | "collector" | "admin") {
    return getPrisma().user.count({
      where: {
        role,
      },
    });
  },
};
