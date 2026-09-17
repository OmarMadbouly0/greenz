import jwt from "jsonwebtoken";
import { InvalidTokenError } from "@/shared/errors/application-error";

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
  let payload: string | jwt.JwtPayload;
  try {
    payload = jwt.verify(token, getJwtSecret());
  } catch {
    throw new InvalidTokenError("Invalid or expired token.");
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof payload.userId !== "number"
  ) {
    throw new InvalidTokenError("Invalid token payload.");
  }

  return {
    userId: payload.userId,
  };
}
