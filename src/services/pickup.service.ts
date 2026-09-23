import { materialRepository } from "@/repositories/material.repository";
import {
  CreatePickupInput,
  UpdatePayoutStatusInput,
  UpdatePickupStatusInput,
} from "./pickup.schemas";
import { pickupRepository } from "@/repositories/pickup.repository";
import { userRepository } from "@/repositories/user.repository";

import {
  InvalidRequestError,
  NotFoundError,
} from "@/shared/errors/application-error";

type UserRole = "customer" | "collector" | "admin";

export const pickupService = {
  async getPickups(userId: number, role: UserRole) {
    if (role === "customer") {
      return pickupRepository.getPickupsByCustomerId(userId);
    }
    if (role === "collector") {
      return pickupRepository.getPickupsByCollectorId(userId);
    }
    if (role === "admin") {
      return pickupRepository.getAllPickups();
    }
    throw new InvalidRequestError("Invalid user role.");
  },

  async getPickupById(userId: number, role: UserRole, pickupId: number) {
    if (role === "customer") {
      const pickup = await pickupRepository.getPickupByUserId(userId, pickupId);
      return pickup;
    }

    if (role === "collector") {
      const pickup = await pickupRepository.getPickupByCollectorId(
        userId,
        pickupId,
      );
      return pickup;
    }
    if (role === "admin") {
      const pickup = await pickupRepository.getPickupById(pickupId);
      return pickup;
    }

    throw new InvalidRequestError("Invalid user role.");
  },

  async cancelPickup(userId: number, pickupId: number) {
    const pickup = await pickupRepository.getPickupByUserId(userId, pickupId);
    if (!pickup) {
      throw new NotFoundError("Pickup not found.");
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
      throw new NotFoundError("Pickup not found.");
    }
    return pickupRepository.updatePickupStatus(collectorId, pickupId, input);
  },

  async assignPickupToCollector(collectorId: number, pickupId: number) {
    const pickup = await pickupRepository.getPickupById(pickupId);
    if (!pickup) {
      throw new NotFoundError("Pickup not found.");
    }
    const collector = await userRepository.getCollectorById(collectorId);

    if (!collector) {
      throw new NotFoundError("Collector not found.");
    }
    return pickupRepository.assignPickupToCollector(collectorId, pickupId);
  },

  async updatePayoutStatus(pickupId: number, input: UpdatePayoutStatusInput) {
    const pickup = await pickupRepository.getPickupById(pickupId);

    if (!pickup) {
      throw new NotFoundError("Pickup not found.");
    }

    if (pickup.status !== "completed") {
      throw new InvalidRequestError(
        "Payout can only be updated for completed pickups.",
      );
    }

    if (pickup.payout_status !== "pending") {
      throw new InvalidRequestError("Payout has already been done.");
    }

    return pickupRepository.updatePayoutStatus(pickupId, input);
  },
};
