import { RegisterInput } from "@/services/auth.schemas";
import { userRepository } from "@/repositories/user.repository";
import { ConflictError } from "@/shared/errors/application-error";
import { hashPassword } from "@/modules/identity/application/password";
export const authService = {
  async registerUser(input: RegisterInput) {
    const emailExists = await userRepository.emailExists(input.email);
    if (emailExists) {
      throw new ConflictError("Email already exists");
    }
    const passwordHash = await hashPassword(input.password);
    return userRepository.create({
      fullName: input.fullName,
      email: input.email,
      passwordHash: passwordHash,
    });
  },
};
