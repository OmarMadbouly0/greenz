import { userRepository } from "@/repositories/user.repository";

export const collectorService = {
  async getAllCollectors() {
    return userRepository.getUsersByRole("collector");
  },
};
