import { NextResponse } from "next/server";
import { isAgentRequest } from "@/lib/agent-auth";
import { getLlmConfig } from "@/lib/platform-settings";

export async function GET(req: Request) {
  if (!isAgentRequest(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ llm: await getLlmConfig() });
}
