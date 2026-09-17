import { getPrisma } from "@/infrastructure/database/prisma";
export const materialRepository = {
  async getMaterials() {
    return getPrisma().material.findMany();
  },
  async getMaterialById(materialId: number) {
    return getPrisma().material.findUnique({
      where: { id: materialId },
    });
  },
};
