"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

export function AcceptForm({ id }: { id: string }) {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function accept() {
    setBusy(true);
    const { data, error } = await authClient.organization.acceptInvitation({ invitationId: id });
    if (error || !data) {
      setBusy(false);
      return setError(error?.message ?? "This invitation is not valid for your account");
    }
    await authClient.organization.setActive({ organizationId: data.invitation.organizationId });
    router.push("/dashboard");
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-4 p-6">
      <h1 className="text-2xl font-semibold">Join a restaurant</h1>
      {isPending ? null : session ? (
        <>
          <p className="text-sm text-muted-foreground">
            Signed in as {session.user.email}. The invitation only works for the address it was sent to.
          </p>
          <Button onClick={accept} disabled={busy}>
            Accept invitation
          </Button>
        </>
      ) : (
        <p>
          <Link href="/" className="underline">
            Sign in or create an account
          </Link>{" "}
          with the email address you were invited at, then open this link again.
        </p>
      )}
      {error && <p className="text-destructive-text">{error}</p>}
    </main>
  );
}
