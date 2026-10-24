// Client-safe constants (no DB imports) shared by the admin UI and server code.
export const LLM_PROVIDERS = {
  openai: { label: "OpenAI", defaultModel: "gpt-4o-mini" },
  deepseek: { label: "DeepSeek", defaultModel: "deepseek-chat" },
} as const;
export type LlmProvider = keyof typeof LLM_PROVIDERS;
