import { materialRepository } from "@/repositories/material.repository";
import {
  ConflictError,
  NotFoundError,
} from "@/shared/errors/application-error";
import { CreateMaterialInput, UpdateMaterialInput } from "./material.schemas";
export const materialService = {
  async getMaterials() {
    const materials = await materialRepository.getMaterials();
    return materials;
  },
  async getMaterialById(materialId: number) {
    const material = await materialRepository.getMaterialById(materialId);
    if (!material) {
      throw new NotFoundError(`Material not found.`);
    }
    return material;
  },
  async updateMaterial(materialId: number, input: UpdateMaterialInput) {
    const existingMaterial =
      await materialRepository.getMaterialById(materialId);
    if (!existingMaterial) {
      throw new NotFoundError(`Material not found.`);
    }

    if (
      input.name !== undefined &&
      input.name !== existingMaterial.name &&
      (await materialRepository.getMaterialByName(input.name))
    ) {
      throw new ConflictError(
        `Material with name ${input.name} already exists.`,
      );
    }

    const material = await materialRepository.updateMaterial(materialId, input);
    if (!material) {
      throw new NotFoundError(`Material not found.`);
    }
    return material;
  },
  async createMaterial(input: CreateMaterialInput) {
    if (await materialRepository.getMaterialByName(input.name)) {
      throw new ConflictError(
        `Material with name ${input.name} already exists.`,
      );
    }
    const material = await materialRepository.createMaterial(input);
    return material;
  },
  async deleteMaterial(materialId: number) {
    if (!(await materialRepository.getMaterialById(materialId))) {
      throw new NotFoundError(`Material not found.`);
    }
    const material = await materialRepository.deleteMaterial(materialId);
    return material;
  },
};
