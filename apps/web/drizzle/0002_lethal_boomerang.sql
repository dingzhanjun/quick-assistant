CREATE TABLE "platform_settings" (
	"id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"llm_provider" text DEFAULT 'openai' NOT NULL,
	"llm_model" text DEFAULT 'gpt-4o-mini' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
