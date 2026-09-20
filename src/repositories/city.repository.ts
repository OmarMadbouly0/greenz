import { getPrisma } from "@/infrastructure/database/prisma";
export const cityRepository = {
  async findById(id: number) {
    return getPrisma().city.findUnique({
      where: { id },
    });
  },
};
