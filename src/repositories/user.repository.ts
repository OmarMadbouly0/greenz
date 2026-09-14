import { getPrisma } from "@/infrastructure/database/prisma";

export const userRepository = {
  async findById(id: number) {
    return getPrisma().user.findUnique({
      where: { id },
    });
  },
};
