import { eq } from "drizzle-orm";
import { db } from "@/db";
import { platformSettings } from "@/db/schema";
import { LLM_PROVIDERS, type LlmProvider } from "./llm-providers";

export async function getLlmConfig(): Promise<{ provider: LlmProvider; model: string }> {
  const [row] = await db.select().from(platformSettings).where(eq(platformSettings.id, "default"));
  return {
    provider: row?.llmProvider ?? "openai",
    model: row?.llmModel ?? LLM_PROVIDERS.openai.defaultModel,
  };
}
