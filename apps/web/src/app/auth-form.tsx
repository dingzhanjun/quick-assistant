"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

export function AuthForm() {
  const router = useRouter();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setNotice("");
    setBusy(true);
    try {
      if (mode === "up") {
        const { error } = await authClient.signUp.email({
          name,
          email,
          password,
          callbackURL: "/dashboard",
        });
        if (error) return setError(error.message ?? "Could not sign up");
        setNotice("Check your email for a verification link to finish signing up.");
      } else {
        const { error } = await authClient.signIn.email({ email, password });
        if (error) {
          return setError(
            error.status === 403
              ? "Please verify your email first. Check your inbox for the link."
              : (error.message ?? "Could not sign in"),
          );
        }
        router.push("/dashboard");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Button
        variant="outline"
        className="w-full"
        onClick={() => authClient.signIn.social({ provider: "google", callbackURL: "/dashboard" })}
      >
        Continue with Google
      </Button>
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
      </div>
      <form onSubmit={submit} className="space-y-3">
        {mode === "up" && (
          <div className="space-y-2">
            <Label htmlFor="name">Your name</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
        )}
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
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete={mode === "up" ? "new-password" : "current-password"}
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        {mode === "in" && (
          <Link href="/forgot-password" className="block text-sm text-muted-foreground underline">
            Forgot password?
          </Link>
        )}
        <Button type="submit" className="w-full" disabled={busy}>
          {mode === "up" ? "Create account" : "Sign in"}
        </Button>
        {error && <p className="text-sm text-destructive-text">{error}</p>}
        {notice && <p className="text-sm text-success-text">{notice}</p>}
      </form>
      <button
        type="button"
        className="text-sm text-muted-foreground underline"
        onClick={() => {
          setMode(mode === "in" ? "up" : "in");
          setError("");
          setNotice("");
        }}
      >
        {mode === "in" ? "No account? Sign up with email" : "Have an account? Sign in"}
      </button>
    </div>
  );
}
