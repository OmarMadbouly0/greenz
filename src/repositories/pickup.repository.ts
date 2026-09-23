import { getPrisma } from "@/infrastructure/database/prisma";
import {
  UpdatePayoutStatusInput,
  UpdatePickupStatusInput,
} from "@/services/pickup.schemas";

export const pickupRepository = {
  async getPickupsByCustomerId(userId: number) {
    return getPrisma().pickup.findMany({
      where: {
        customer_id: userId,
      },
      orderBy: {
        created_at: "desc",
      },
    });
  },
  async getAllPickups() {
    return getPrisma().pickup.findMany({
      orderBy: {
        created_at: "desc",
      },
      select: {
        id: true,
        status: true,
        note: true,
        payout: true,
        payout_status: true,
        requested_at: true,
        completed_at: true,
        cancelled_at: true,
        created_at: true,
        updated_at: true,

        customer: {
          select: {
            id: true,
            full_name: true,
            email: true,
          },
        },

        collector: {
          select: {
            id: true,
            full_name: true,
            email: true,
          },
        },

        items: {
          select: {
            id: true,
            quantity: true,
            price_per_unit: true,
            note: true,

            material: {
              select: {
                id: true,
                name: true,
                unit: true,
              },
            },
          },
        },
      },
    });
  },

  async getPickupsByCollectorId(userId: number) {
    return getPrisma().pickup.findMany({
      where: {
        collector_id: userId,
      },
      orderBy: {
        created_at: "desc",
      },
    });
  },
  async getPickupByUserId(userId: number, pickupId: number) {
    return getPrisma().pickup.findFirst({
      where: {
        id: pickupId,
        customer_id: userId,
      },
      include: {
        items: true,
      },
    });
  },

  async createPickup(
    userId: number,
    input: {
      note?: string | null;
      payout: number;
      items: {
        material_id: number;
        quantity: number;
        price_per_unit: number;
        note?: string | null;
      }[];
    },
  ) {
    return getPrisma().pickup.create({
      data: {
        customer_id: userId,
        note: input.note,
        payout: input.payout,
        items: {
          create: input.items.map((item) => ({
            material_id: item.material_id,
            quantity: item.quantity,
            price_per_unit: item.price_per_unit,
            note: item.note,
          })),
        },
      },
    });
  },
  async cancelPickup(userId: number, pickupId: number) {
    return getPrisma().pickup.update({
      where: {
        id: pickupId,
        customer_id: userId,
        status: {
          in: ["pending", "assigned"],
        },
      },
      data: {
        status: "cancelled",
        cancelled_at: new Date(),
        payout_status: "cancelled",
      },
    });
  },
  async getPickupByCollectorId(collectorId: number, pickupId: number) {
    return getPrisma().pickup.findFirst({
      where: {
        id: pickupId,
        collector_id: collectorId,
      },
      include: {
        items: true,
      },
    });
  },

  async updatePickupStatus(
    collectorId: number,
    pickupId: number,
    { status }: UpdatePickupStatusInput,
  ) {
    return getPrisma().pickup.update({
      where: {
        id: pickupId,
        collector_id: collectorId,
      },
      data: {
        status,
        completed_at: status === "completed" ? new Date() : undefined,
      },
    });
  },

  async getPickupById(pickupId: number) {
    return getPrisma().pickup.findUnique({
      where: {
        id: pickupId,
      },
      select: {
        id: true,
        status: true,
        note: true,
        payout: true,
        payout_status: true,
        requested_at: true,
        completed_at: true,
        cancelled_at: true,
        created_at: true,
        updated_at: true,

        customer: {
          select: {
            id: true,
            full_name: true,
            email: true,
          },
        },

        collector: {
          select: {
            id: true,
            full_name: true,
            email: true,
          },
        },

        items: {
          select: {
            id: true,
            quantity: true,
            price_per_unit: true,
            note: true,

            material: {
              select: {
                id: true,
                name: true,
                unit: true,
              },
            },
          },
        },
      },
    });
  },
  async assignPickupToCollector(collectorId: number, pickupId: number) {
    return getPrisma().pickup.update({
      where: {
        id: pickupId,
      },
      data: {
        collector_id: collectorId,
        status: "assigned",
      },
    });
  },
  async updatePayoutStatus(
    pickupId: number,
    { status }: UpdatePayoutStatusInput,
  ) {
    return getPrisma().pickup.update({
      where: {
        id: pickupId,
      },
      data: {
        payout_status: status,
      },
    });
  },

  async countPickups() {
    return getPrisma().pickup.count();
  },

  async countPickupsByStatus(
    status:
      | "pending"
      | "assigned"
      | "on_the_way"
      | "arrived"
      | "completed"
      | "cancelled",
  ) {
    return getPrisma().pickup.count({
      where: {
        status,
      },
    });
  },

  async countPayoutsByStatus(status: "pending" | "paid" | "cancelled") {
    return getPrisma().pickup.count({
      where: {
        payout_status: status,
      },
    });
  },
};
