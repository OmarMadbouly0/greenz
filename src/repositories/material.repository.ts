import { getPrisma } from "@/infrastructure/database/prisma";
import {
  CreateMaterialInput,
  UpdateMaterialInput,
} from "@/services/material.schemas";
export const materialRepository = {
  async getMaterials() {
    return getPrisma().material.findMany();
  },
  async getMaterialById(materialId: number) {
    return getPrisma().material.findUnique({
      where: { id: materialId },
    });
  },
  async getMaterialsByIds(materialsIds: number[]) {
    return getPrisma().material.findMany({
      where: {
        id: {
          in: materialsIds,
        },
      },
    });
  },
  async getMaterialByName(name: string) {
    return getPrisma().material.findUnique({
      where: { name },
    });
  },
  async createMaterial(input: CreateMaterialInput) {
    return getPrisma().material.create({
      data: {
        name: input.name,
        unit: input.unit,
        current_price: input.price,
        description: input.description,
      },
    });
  },
  async updateMaterial(materialId: number, input: UpdateMaterialInput) {
    return getPrisma().material.update({
      where: { id: materialId },
      data: {
        name: input.name,
        description: input.description,
        price: input.price,
        unit: input.unit,
      },
    });
  },
  async deleteMaterial(materialId: number) {
    return getPrisma().material.delete({
      where: { id: materialId },
    });
  },
};
