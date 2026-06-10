import { NextRequest, NextResponse } from "next/server";
import { validateApiKey } from "./redis";

export async function requireApiKey(req: NextRequest): Promise<NextResponse | null> {
  const key = req.headers.get("x-api-key");
  if (!key) {
    return NextResponse.json({ error: "Missing x-api-key header" }, { status: 401 });
  }
  const valid = await validateApiKey(key);
  if (!valid) {
    return NextResponse.json({ error: "Invalid API key" }, { status: 403 });
  }
  return null;
}
