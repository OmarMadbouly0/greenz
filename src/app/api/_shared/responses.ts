import { NextResponse } from "next/server";

export function apiOk(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export function apiError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}
