import { materialRepository } from "@/repositories/material.repository";
import { CreatePickupInput } from "./pickup.schemas";
import { pickupRepository } from "@/repositories/pickup.repository";
import { InvalidRequestError } from "@/shared/errors/application-error";
export const pickupService = {
  async getPickups(userId: number) {
    return pickupRepository.getPickupsByUserId(userId);
  },
  async createPickup(userId: number, input: CreatePickupInput) {
    const materialIds = input.items.map((item) => item.materialId);
    const materials = await materialRepository.getMaterialsByIds(materialIds);

    const foundIds = materials.map((material) => material.id);
    const missingIds = materialIds.filter((id) => !foundIds.includes(id));

    if (missingIds.length > 0) {
      throw new InvalidRequestError("Some materials are not available.", {
        materialIds: missingIds,
      });
    }

    const items = input.items.map((item) => {
      return {
        material_id: item.materialId,
        quantity: item.quantity,
        price_per_unit: Number(
          materials.find((material) => material.id === item.materialId)!
            .current_price,
        ),
        note: item.note,
      };
    });

    const payout = items.reduce(
      (total, item) =>
        total + Number(item.quantity) * Number(item.price_per_unit),
      0,
    );

    return pickupRepository.createPickup(userId, {
      note: input.note,
      payout,
      items,
    });
  },
};
