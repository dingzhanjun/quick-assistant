import { NextResponse } from "next/server";
import { authenticateAgent } from "@/lib/print/agent";
import { agentRelease } from "@/lib/print/release";

// Which print-agent version the platform wants and where its files are (lib/print/release.ts: the agent files built into this
// web image, or the PRINT_AGENT_* override). A newer version rolls out with the next web deploy; none = agents stay as they
// are. The agent verifies the checksum, requires https, keeps the old binary for a rollback, and only updates between tickets.
export async function GET(req: Request) {
  const agent = await authenticateAgent(req);
  if (!agent) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const release = agentRelease();
  if (!release) return new Response(null, { status: 204 });
  return NextResponse.json({ version: release.version, base_url: release.baseUrl });
}
