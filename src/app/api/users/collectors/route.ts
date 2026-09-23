import { getCurrentUser } from "@/modules/identity/application/current-user";
import { requireRole } from "@/modules/identity/application/guards";
import { apiOk } from "../../_shared/responses";
import { handleRouteError } from "../../_shared/route-errors";
import { collectorService } from "@/services/collector.service";
import { readJsonBody } from "../../_shared/request-body";
import { parseInput } from "@/shared/validation/parse-input";
import { registerCollectorSchema } from "@/services/collector.schemas";
export async function GET() {
  try {
    const currentUser = await getCurrentUser();
    await requireRole(currentUser, ["admin"]);
    const collectors = await collectorService.getAllCollectors();
    return apiOk(collectors, 200);
  } catch (error) {
    return handleRouteError(error);
  }
}
export async function POST(request: Request) {
  try {
    const currentUser = await getCurrentUser();
    await requireRole(currentUser, ["admin"]);

    const body = await readJsonBody(request);
    const input = await parseInput(registerCollectorSchema, body);
    const collector = await collectorService.registerCollector(input);
    return apiOk(collector, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
