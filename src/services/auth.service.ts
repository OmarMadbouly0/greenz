import {
  LoginInput,
  RegisterInput,
  UpdateProfileInput,
} from "@/services/auth.schemas";
import { userRepository } from "@/repositories/user.repository";
import {
  ConflictError,
  NotFoundError,
  UnauthorizedError,
} from "@/shared/errors/application-error";
import {
  hashPassword,
  verifyPassword,
} from "@/modules/identity/application/password";
import { generateToken } from "@/modules/identity/application/jwt";
import { addressRepository } from "@/repositories/address.repository";
import { cityRepository } from "@/repositories/city.repository";
import { withTransaction } from "@/infrastructure/database/prisma";
import { getCurrentUserOrNull } from "@/modules/identity/application/current-user";

export const authService = {
  async registerUser(input: RegisterInput) {
    const currentUser = await getCurrentUserOrNull();

    if (currentUser) {
      throw new ConflictError("You are already logged in.");
    }
    const emailExists = await userRepository.emailExists(input.email);
    if (emailExists) {
      throw new ConflictError("Email already exists");
    }
    const passwordHash = await hashPassword(input.password);

    const city = await cityRepository.findById(input.address.cityId);

    if (!city) {
      throw new NotFoundError("City not found.");
    }

    return withTransaction(async (tx) => {
      const user = await userRepository.create(tx, {
        fullName: input.fullName,
        email: input.email,
        passwordHash: passwordHash,
      });

      const address = await addressRepository.create(tx, user.id, {
        cityId: input.address.cityId,
        street: input.address.street,
        building: input.address.building,
        apartment: input.address.apartment,
        floor: input.address.floor,
      });
      return {
        user,
        address,
      };
    });
  },
  async loginUser(input: LoginInput) {
    const currentUser = await getCurrentUserOrNull();
    if (currentUser) {
      throw new ConflictError("You are already logged in.");
    }

    const user = await userRepository.findByEmail(input.email);
    if (!user) {
      throw new UnauthorizedError("Invalid email or password.");
    }
    const isMatch = await verifyPassword(input.password, user.password_hash);
    if (!isMatch) {
      throw new UnauthorizedError("Invalid email or password.");
    }
    await userRepository.updateLastLogin(user.id);
    const token = await generateToken(user.id);

    return {
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        role: user.role,
        lastLogin: user.last_login_at,
      },
      token,
    };
  },

  async updateUserProfile(userId: number, input: UpdateProfileInput) {
    return withTransaction(async (tx) => {
      if (input.fullName !== undefined) {
        await userRepository.updateProfile(tx, userId, {
          fullName: input.fullName,
        });
      }

      if (input.address) {
        await addressRepository.update(tx, userId, {
          cityId: input.address.cityId,
          street: input.address.street,
          building: input.address.building,
          apartment: input.address.apartment,
          floor: input.address.floor,
        });
      }
      const user = await userRepository.findByIdTx(userId, tx);
      const address = await addressRepository.findByUserIdTx(userId, tx);

      return {
        user,
        address,
      };
    });
  },
};
