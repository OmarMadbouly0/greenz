import { materialRepository } from "@/repositories/material.repository";
import { NotFoundError } from "@/shared/errors/application-error";
export const materialService = {
  async getMaterials() {
    const materials = await materialRepository.getMaterials();
    if (!materials) {
      throw new NotFoundError("Materials not found.");
    }
    return materials;
  },
  async getMaterialById(materialId: number) {
    const material = await materialRepository.getMaterialById(materialId);
    if (!material) {
      throw new NotFoundError(`Material not found.`);
    }
    return material;
  },
};
