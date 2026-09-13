import { prisma } from "@/lib/prisma";

export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;

    return true;
  } catch (error) {
    console.error("Database connection failed:", error);

    return false;
  }
}
