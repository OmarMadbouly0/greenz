import { getPrisma } from "@/infrastructure/database/prisma";

export const healthService = {
  async checkDatabaseConnection(): Promise<boolean> {
    try {
      await getPrisma().$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      console.error("Database connection error:", error);
      return false;
    }
  },
};
