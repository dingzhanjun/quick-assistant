"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export default function Onboarding() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const { data, error } = await authClient.organization.create({ name, slug: slugify(name) });
    if (error || !data) return setError(error?.message ?? "Could not create restaurant");
    await authClient.organization.setActive({ organizationId: data.id });
    router.push("/dashboard");
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-4 p-6">
      <h1 className="text-2xl font-semibold">Name your restaurant</h1>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Joe's Pizza"
          required
        />
        <Button type="submit">Create</Button>
        {error && <p className="text-destructive-text">{error}</p>}
      </form>
    </main>
  );
}
