import { getCurrentUser } from "@/modules/identity/application/current-user";
import { requireRole } from "@/modules/identity/application/guards";
import { apiOk } from "../../../_shared/responses";
import { handleRouteError } from "../../../_shared/route-errors";
import { userRepository } from "@/repositories/user.repository";

export async function GET() {
  try {
    const currentUser = await getCurrentUser();
    await requireRole(currentUser, ["admin"]);
    const customers = await userRepository.getUsersByRole("customer");
    return apiOk(customers, 200);
  } catch (error) {
    return handleRouteError(error);
  }
}
