import { checkDatabaseConnection } from "@/lib/db";

export async function GET() {
  const isConnected = await checkDatabaseConnection();

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
