import jwt from "jsonwebtoken";

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error("JWT_SECRET is required.");
  }

  return secret;
}

export function generateToken(userId: number): string {
  return jwt.sign({ userId }, getJwtSecret(), { expiresIn: "7d" });
}

export function verifyToken(token: string): { userId: number } {
  const payload = jwt.verify(token, getJwtSecret()) as { userId: number };
  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof payload.userId !== "number"
  ) {
    throw new Error("Invalid token payload.");
  }

  return {
    userId: payload.userId,
  };
}
