import { cookies } from "next/headers";
import { apiOk } from "@/app/api/_shared/responses";
export async function POST() {
  const cookieStore = await cookies();
  cookieStore.delete("token");
  return apiOk({}, 200);
}
