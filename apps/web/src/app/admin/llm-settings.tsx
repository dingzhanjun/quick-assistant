"use client";

import { useState, useTransition } from "react";
import { toast } from "@/lib/toast";
import { ConfirmButton } from "@/components/confirm-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { LLM_PROVIDERS, type LlmProvider } from "@/lib/llm-providers";
import { setLlmConfig } from "./actions";

export function LlmSettings(props: { provider: LlmProvider; model: string }) {
  const [provider, setProvider] = useState(props.provider);
  const [model, setModel] = useState(props.model);
  const [pending, startTransition] = useTransition();

  function save() {
    startTransition(async () => {
      const res = await setLlmConfig(provider, model);
      if (res.ok) toast.success("Saved. Applies to new calls.");
      else toast.error(res.error);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Voice agent LLM</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => e.preventDefault()} className="flex flex-wrap items-end gap-3">
          <div className="space-y-2">
            <Label htmlFor="provider">Provider</Label>
            <Select
              id="provider"
              ariaLabel="Provider"
              value={provider}
              width={200}
              onChange={(p) => {
                setProvider(p as LlmProvider);
                setModel(LLM_PROVIDERS[p as LlmProvider].defaultModel);
              }}
              options={Object.entries(LLM_PROVIDERS).map(([key, v]) => ({ label: v.label, value: key }))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="model">Model</Label>
            <Input id="model" value={model} onChange={(e) => setModel(e.target.value)} required />
          </div>
          <ConfirmButton
            variant="default"
            size="default"
            destructive={false}
            disabled={pending || !model.trim() || (provider === props.provider && model === props.model)}
            title="Change the voice agent's model?"
            description={`Every restaurant's phone agent will use ${LLM_PROVIDERS[provider].label} / ${model.trim()} for new calls.`}
            confirmLabel="Change model"
            onConfirm={save}
          >
            Save
          </ConfirmButton>
        </form>
        <p className="mt-3 text-sm text-muted-foreground">
          API keys are set on the agent via <code>OPENAI_API_KEY</code> / <code>DEEPSEEK_API_KEY</code>.
        </p>
      </CardContent>
    </Card>
  );
}
