import { materialRepository } from "@/repositories/material.repository";
import {
  CreatePickupInput,
  UpdatePayoutStatusInput,
  UpdatePickupStatusInput,
} from "./pickup.schemas";
import { pickupRepository } from "@/repositories/pickup.repository";
import { userRepository } from "@/repositories/user.repository";

import {
  ConflictError,
  NotFoundError,
  UnauthorizedError,
} from "@/shared/errors/application-error";
import { walletRepository } from "@/repositories/wallet.repository";
import { Prisma } from "@/../generated/prisma/client";
import { PickupListQuery } from "./pickup.schemas";
import { pageResult } from "@/shared/pagination";
import { withTransaction } from "@/infrastructure/database/prisma";

type UserRole = "customer" | "collector" | "admin";

export const pickupService = {
  async getPickups(userId: number, role: UserRole) {
    if (role === "customer") {
      return pickupRepository.getPickupsByCustomerId(userId);
    }
    if (role === "collector") {
      return pickupRepository.getPickupsByCollectorId(userId);
    }
    throw new UnauthorizedError("Invalid user role.");
  },
  async getAllPickups(query: PickupListQuery) {
    const { items, total } = await pickupRepository.getAllPickups(query);

    return pageResult(items, total, query.page, query.pageSize);
  },

  async getPickupById(userId: number, role: UserRole, pickupId: number) {
    let pickup;

    if (role === "customer") {
      pickup = await pickupRepository.getPickupByUserId(userId, pickupId);
    } else if (role === "collector") {
      pickup = await pickupRepository.getPickupByCollectorId(userId, pickupId);
    } else if (role === "admin") {
      pickup = await pickupRepository.getPickupById(pickupId);
    } else {
      throw new UnauthorizedError("Invalid user role.");
    }

    if (!pickup) {
      throw new NotFoundError("Pickup not found.");
    }

    return pickup;
  },

  async cancelPickup(userId: number, pickupId: number) {
    return withTransaction(async (tx) => {
      await pickupRepository.lockPickup(tx, pickupId);

      const pickup = await pickupRepository.getPickupByIdTx(tx, pickupId);
      if (!pickup || pickup.customer_id !== userId) {
        throw new NotFoundError("Pickup not found.");
      }
      if (pickup.status !== "pending" && pickup.status !== "assigned") {
        throw new ConflictError(
          "Only pending or assigned pickups can be canceled.",
        );
      }
      return pickupRepository.cancelPickup(tx, userId, pickupId);
    });
  },

  async createPickup(userId: number, input: CreatePickupInput) {
    const wallet = await walletRepository.getWalletByUserId(userId);

    if (!wallet) {
      throw new ConflictError(
        "You must register a wallet before making a pickup.",
      );
    }
    const materialIds = input.items.map((item) => item.materialId);
    const materials = await materialRepository.getMaterialsByIds(materialIds);

    const foundIds = materials.map((material) => material.id);
    const missingIds = materialIds.filter((id) => !foundIds.includes(id));

    if (missingIds.length > 0) {
      throw new ConflictError("Some materials are not available.", {
        materialIds: missingIds,
      });
    }

    const items = input.items.map((item) => {
      return {
        material_id: item.materialId,
        quantity: item.quantity,
        price_per_unit: Prisma.Decimal(
          materials.find((material) => material.id === item.materialId)!
            .current_price,
        ),
        note: item.note,
      };
    });

    const payout = items.reduce(
      (total, item) =>
        total.plus(new Prisma.Decimal(item.quantity).mul(item.price_per_unit)),
      new Prisma.Decimal(0),
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
    return withTransaction(async (tx) => {
      await pickupRepository.lockPickup(tx, pickupId);

      const pickup = await pickupRepository.getPickupByIdTx(tx, pickupId);
      if (!pickup || pickup.collector_id !== collectorId) {
        throw new NotFoundError("Pickup not found.");
      }
      if (pickup.status === "completed" || pickup.status === "cancelled") {
        throw new ConflictError("Pickup has already been handled.");
      }
      if (pickup.status === "pending") {
        throw new ConflictError("Pickup must be assigned before updating progress.");
      }
      if (pickup.status === "assigned" && input.status !== "on_the_way") {
        throw new ConflictError(
          "Pickup must move from assigned to on_the_way.",
        );
      }
      if (pickup.status === "on_the_way" && input.status !== "arrived") {
        throw new ConflictError("Pickup must move from on_the_way to arrived.");
      }
      if (pickup.status === "arrived" && input.status !== "completed") {
        throw new ConflictError("Pickup must move from arrived to completed.");
      }

      return pickupRepository.updatePickupStatus(tx, collectorId, pickupId, input);
    });
  },

  async assignPickupToCollector(collectorId: number, pickupId: number) {
    return withTransaction(async (tx) => {
      await pickupRepository.lockPickup(tx, pickupId);

      const pickup = await pickupRepository.getPickupByIdTx(tx, pickupId);
      if (!pickup) {
        throw new NotFoundError("Pickup not found.");
      }
      if (pickup.status !== "pending" || pickup.collector_id !== null) {
        throw new ConflictError("Only pending, unassigned pickups can be assigned.");
      }
      const collector = await userRepository.getCollectorById(tx, collectorId);
      if (!collector) {
        throw new NotFoundError("Collector not found.");
      }
      return pickupRepository.assignPickupToCollector(tx, collectorId, pickupId);
    });
  },

  async unassignPickupFromCollector(pickupId: number) {
    return withTransaction(async (tx) => {
      await pickupRepository.lockPickup(tx, pickupId);

      const pickup = await pickupRepository.getPickupByIdTx(tx, pickupId);
      if (!pickup) {
        throw new NotFoundError("Pickup not found.");
      }
      if (pickup.status !== "assigned" || pickup.collector_id === null) {
        throw new ConflictError("Pickup is not assigned to a collector.");
      }
      return pickupRepository.unassignPickupFromCollector(tx, pickupId);
    });
  },

  //admin
  async updatePayoutStatus(pickupId: number, input: UpdatePayoutStatusInput) {
    return withTransaction(async (tx) => {
      await pickupRepository.lockPickup(tx, pickupId);

      const pickup = await pickupRepository.getPickupByIdTx(tx, pickupId);
      if (!pickup) {
        throw new NotFoundError("Pickup not found.");
      }

      if (pickup.status !== "completed") {
        throw new ConflictError(
          "Payout can only be updated for completed pickups.",
        );
      }

      if (pickup.payout_status !== "pending") {
        throw new ConflictError("Payout has already been done.");
      }

      if (!pickup.payout) {
        throw new ConflictError("Pickup has no payout amount.");
      }

      if (input.status === "paid") {
        const wallet = await walletRepository.getWalletByUserIdTx(
          tx,
          pickup.customer.id,
        );
        if (!wallet) {
          throw new NotFoundError("Customer wallet not found.");
        }

        return pickupRepository.payPickup(
          tx,
          pickupId,
          wallet.id,
          pickup.payout,
        );
      }

      if (input.status === "cancelled") {
        return pickupRepository.cancelPayout(tx, pickupId);
      }
    });
  },
};
