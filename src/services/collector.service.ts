import { userRepository } from "@/repositories/user.repository";
import { pageResult } from "@/shared/pagination";
import { PaginationInput } from "@/shared/validation/pagination.schema";

export const collectorService = {
  async getAllCollectors(pagination: PaginationInput) {
    const { items, total } = await userRepository.getUsersByRole(
      "collector",
      pagination,
    );

    return pageResult(items, total, pagination.page, pagination.pageSize);
  },
};
