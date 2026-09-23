import { userRepository } from "@/repositories/user.repository";
import { RegisterCollectorInput } from "./collector.schemas";
import {
  ConflictError,
  InvalidRequestError,
} from "@/shared/errors/application-error";
import { hashPassword } from "@/modules/identity/application/password";
import { cityRepository } from "@/repositories/city.repository";
import { addressRepository } from "@/repositories/address.repository";

export const collectorService = {
  async getAllCollectors() {
    return userRepository.getUsersByRole("collector");
  },
  async registerCollector(input: RegisterCollectorInput) {
    const emailExists = await userRepository.emailExists(input.email);
    if (emailExists) {
      throw new ConflictError("Email already exists");
    }
    const passwordHash = await hashPassword(input.password);

    const city = await cityRepository.findById(input.address.cityId);

    if (!city) {
      throw new InvalidRequestError("Invalid city");
    }

    const user = await userRepository.createCollector({
      fullName: input.fullName,
      email: input.email,
      passwordHash: passwordHash,
    });

    const address = await addressRepository.create(user.id, {
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
  },
};
