import { handleRouteError } from "@/app/api/_shared/route-errors";
import { parseId } from "@/shared/validation/parse-id";
import { apiOk } from "../../_shared/responses";
import { materialService } from "@/services/material.service";
import { readJsonBody } from "../../_shared/request-body";
import { updateMaterialSchema } from "@/services/material.schemas";
import { parseInput } from "@/shared/validation/parse-input";
import { requireRole } from "@/modules/identity/application/guards";
import { getCurrentUser } from "@/modules/identity/application/current-user";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ materialId: string }> },
) {
  try {
    const materialId = parseId((await params).materialId);
    const material = await materialService.getMaterialById(materialId);
    return apiOk(material);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PATCH(
  request: Request,
  {
    params,
  }: {
    params: Promise<{ materialId: string }>;
  },
) {
  try {
    await requireRole(await getCurrentUser(), ["admin"]);
    const materialId = parseId((await params).materialId);
    const body = await readJsonBody(request);
    const input = parseInput(updateMaterialSchema, body);
    const material = await materialService.updateMaterial(materialId, input);
    return apiOk(material);
  } catch (error) {
    return handleRouteError(error);
  }
}
export async function DELETE({
  params,
}: {
  params: Promise<{ materialId: string }>;
}) {
  try {
    await requireRole(await getCurrentUser(), ["admin"]);
    const materialId = parseId((await params).materialId);
    const material = await materialService.deleteMaterial(materialId);
    return apiOk(material);
  } catch (error) {
    return handleRouteError(error);
  }
}
