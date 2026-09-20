import { getPrisma } from "@/infrastructure/database/prisma";

export const addressRepository = {
  async create(
    userId: number,
    input: {
      cityId: number;
      street: string;
      building: string;
      apartment?: string | null;
      floor?: string | null;
    },
  ) {
    return getPrisma().address.create({
      data: {
        user_id: userId,
        city_id: input.cityId,
        street: input.street,
        building: input.building,
        apartment: input.apartment,
        floor: input.floor,
      },
    });
  },

  async findByUserId(userId: number) {
    return getPrisma().address.findUnique({
      where: { user_id: userId },
    });
  },

  async update(
    userId: number,
    input: {
      cityId?: number;
      street?: string;
      building?: string;
      apartment?: string | null;
      floor?: string | null;
    },
  ) {
    return getPrisma().address.update({
      where: { user_id: userId },
      data: {
        city_id: input.cityId,
        street: input.street,
        building: input.building,
        apartment: input.apartment,
        floor: input.floor,
      },
    });
  },
};
