import { materialService } from "@/services/material.service";
import { handleRouteError } from "../_shared/route-errors";
import { apiOk } from "../_shared/responses";
export async function GET() {
  try {
    const materials = await materialService.getMaterials();
    return apiOk(materials);
  } catch (error) {
    return handleRouteError(error);
  }
}
