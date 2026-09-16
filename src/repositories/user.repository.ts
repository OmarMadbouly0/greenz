import { getPrisma } from "@/infrastructure/database/prisma";
import { email } from "zod";

export const userRepository = {
  async findById(id: number) {
    return getPrisma().user.findUnique({
      where: { id },
    });
  },
  async emailExists(email: string): Promise<boolean> {
    const user = await getPrisma().user.findUnique({
      where: { email },
      select: { id: true },
    });

    return user !== null;
  },
  async create(input: {
    fullName: string;
    email: string;
    passwordHash: string;
  }) {
    return getPrisma().user.create({
      data: {
        full_name: input.fullName,
        email: input.email,
        password_hash: input.passwordHash,
        role: "customer",
      },
    });
  },
};
