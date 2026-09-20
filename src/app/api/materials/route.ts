import { materialService } from "@/services/material.service";
import { handleRouteError } from "../_shared/route-errors";
import { apiOk } from "../_shared/responses";
import { createMaterialSchema } from "@/services/material.schemas";
import { parseInput } from "@/shared/validation/parse-input";
import { readJsonBody } from "../_shared/request-body";
import { getCurrentUser } from "@/modules/identity/application/current-user";
import { requireRole } from "@/modules/identity/application/guards";
export async function GET() {
  try {
    const materials = await materialService.getMaterials();
    return apiOk(materials);
  } catch (error) {
    return handleRouteError(error);
  }
}
export async function POST(request: Request) {
  try {
    await requireRole(await getCurrentUser(), ["admin"]);
    const body = await readJsonBody(request);
    const input = parseInput(createMaterialSchema, body);
    const material = await materialService.createMaterial(input);
    return apiOk(material, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
