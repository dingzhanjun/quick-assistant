"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    await authClient.requestPasswordReset({ email, redirectTo: "/reset-password" });
    setBusy(false);
    // Same message whether or not the account exists.
    setSent(true);
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-4 p-6">
      <h1 className="text-2xl font-semibold">Reset your password</h1>
      {sent ? (
        <p className="text-muted-foreground">
          If an account exists for {email}, we&apos;ve sent a reset link. Check your inbox.
        </p>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <Button type="submit" className="w-full" disabled={busy}>
            Send reset link
          </Button>
        </form>
      )}
      <Link href="/" className="text-sm text-muted-foreground underline">
        Back to sign in
      </Link>
    </main>
  );
}
