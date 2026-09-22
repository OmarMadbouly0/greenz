import { getPrisma } from "@/infrastructure/database/prisma";

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
  async findByEmail(email: string) {
    return getPrisma().user.findUnique({
      where: { email },
    });
  },
  async updateLastLogin(userId: number) {
    return getPrisma().user.update({
      where: { id: userId },
      data: { last_login_at: new Date() },
    });
  },
  async getCollectorById(userId: number) {
    return getPrisma().user.findFirst({
      where: {
        id: userId,
        role: "collector",
      },
    });
  },
  async updateProfile(
    userId: number,
    input: {
      fullName?: string;
    },
  ) {
    return getPrisma().user.update({
      where: { id: userId },
      data: {
        full_name: input.fullName,
      },
    });
  },
};
