import { healthService } from "@/services/health.service";
export async function GET() {
  const isConnected = await healthService.checkDatabaseConnection();

  if (!isConnected) {
    return Response.json(
      {
        status: "error",
        message: "Database connection failed",
      },
      {
        status: 503,
      },
    );
  }

  return Response.json(
    {
      status: "ok",
      message: "Database connected successfully",
    },
    {
      status: 200,
    },
  );
}
