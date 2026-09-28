import { Prisma } from "../../generated/prisma/client";
export const addressRepository = {
  async findByUserIdTx(userId: number, tx: Prisma.TransactionClient) {
    return tx.address.findUnique({
      where: { user_id: userId },
    });
  },
  async create(
    tx: Prisma.TransactionClient,
    userId: number,
    input: {
      cityId: number;
      street: string;
      building: string;
      apartment?: string | null;
      floor?: string | null;
    },
  ) {
    return tx.address.create({
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

  async update(
    tx: Prisma.TransactionClient,
    userId: number,
    input: {
      cityId?: number;
      street?: string;
      building?: string;
      apartment?: string | null;
      floor?: string | null;
    },
  ) {
    return tx.address.update({
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
