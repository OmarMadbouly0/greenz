import { getPrisma } from "@/infrastructure/database/prisma";
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
    return getPrisma().pickup.updateMany({
      where: {
        id: pickupId,
        customer_id: userId,
        status: {
          in: ["pending", "assigned"],
        },
      },
      data: {
        status: "cancelled",
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
    input: { status: "on_the_way" | "arrived" | "completed" },
  ) {
    return getPrisma().pickup.update({
      where: {
        id: pickupId,
        collector_id: collectorId,
      },
      data: {
        status: input.status,
      },
    });
  },
  async getPickupById(pickupId: number) {
    return getPrisma().pickup.findUnique({
      where: {
        id: pickupId,
      },
      include: {
        items: true,
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
};
