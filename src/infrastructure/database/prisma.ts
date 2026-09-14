import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@/../generated/prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export function getPrisma(): PrismaClient {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required to initialize Prisma.");
  }

  const prisma =
    globalForPrisma.prisma ??
    new PrismaClient({
      adapter: new PrismaPg({
        connectionString: process.env.DATABASE_URL,
      }),
      log:
        process.env.NODE_ENV === "development"
          ? ["query", "error", "warn"]
          : ["error"],
    });

  if (process.env.NODE_ENV !== "production") {
    globalForPrisma.prisma = prisma;
  }

  return prisma;
}

export function withTransaction<T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return getPrisma().$transaction(operation);
}
