import { materialRepository } from "@/repositories/material.repository";
import { CreatePickupInput, UpdatePickupStatusInput } from "./pickup.schemas";
import { pickupRepository } from "@/repositories/pickup.repository";
import { InvalidRequestError } from "@/shared/errors/application-error";

type UserRole = "customer" | "collector" | "admin";

export const pickupService = {
  async getPickups(userId: number, role: UserRole) {
    {
      if (role === "customer") {
        return pickupRepository.getPickupsByCustomerId(userId);
      }

      return pickupRepository.getPickupsByCollectorId(userId);
    }
  },

  async getPickupById(userId: number, role: UserRole, pickupId: number) {
    if (role === "customer") {
      const pickup = await pickupRepository.getPickupByUserId(userId, pickupId);

      if (!pickup) {
        throw new InvalidRequestError("Pickup not found.");
      }
      return pickup;
    }

    if (role === "collector") {
      const pickup = await pickupRepository.getPickupByCollectorId(
        userId,
        pickupId,
      );

      if (!pickup) {
        throw new InvalidRequestError("Pickup not found.");
      }
      return pickup;
    }

    throw new InvalidRequestError("Invalid user role.");
  },

  async cancelPickup(userId: number, pickupId: number) {
    const pickup = await pickupRepository.getPickupByUserId(userId, pickupId);
    if (!pickup) {
      throw new InvalidRequestError("Pickup not found.");
    }
    if (pickup.status !== "pending" && pickup.status !== "assigned") {
      throw new InvalidRequestError(
        "Only pending or assigned pickups can be canceled.",
      );
    }
    return pickupRepository.cancelPickup(userId, pickupId);
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

  async updatePickupStatus(
    collectorId: number,
    pickupId: number,
    input: UpdatePickupStatusInput,
  ) {
    const pickup = await pickupRepository.getPickupByCollectorId(
      collectorId,
      pickupId,
    );
    if (!pickup) {
      throw new InvalidRequestError("Pickup not found.");
    }
    return pickupRepository.updatePickupStatus(collectorId, pickupId, input);
  },
};
