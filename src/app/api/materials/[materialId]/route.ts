import { handleRouteError } from "@/app/api/_shared/route-errors";
import { parseId } from "@/shared/validation/parse-id";
import { apiOk } from "../../_shared/responses";
import { materialService } from "@/services/material.service";

export async function GET({
  params,
}: {
  params: Promise<{ materialId: string }>;
}) {
  try {
    const materialId = parseId((await params).materialId);
    const material = await materialService.getMaterialById(materialId);
    return apiOk(material);
  } catch (error) {
    return handleRouteError(error);
  }
}
