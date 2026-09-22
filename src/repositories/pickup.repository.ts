import { getPrisma } from "@/infrastructure/database/prisma";

export const pickupRepository = {
  async getPickupsByUserId(userId: number) {
    return getPrisma().pickup.findMany({
      where: {
        customer_id: userId,
      },
      orderBy: {
        created_at: "desc",
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
};
