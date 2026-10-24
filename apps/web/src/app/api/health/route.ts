import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";

// For uptime monitors / deploy checks. Reveals nothing beyond up or down.
export async function GET() {
  try {
    await db.execute(sql`select 1`);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
