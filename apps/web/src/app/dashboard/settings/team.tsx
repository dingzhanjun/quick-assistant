"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "@/lib/toast";
import { ConfirmButton } from "@/components/confirm-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { roleLabel } from "@/lib/role-utils";

type Member = { id: string; userId: string; role: string; email: string; name: string };

export function Team({
  organizationId,
  meId,
  members,
  invites,
}: {
  organizationId: string;
  meId: string;
  members: Member[];
  invites: { id: string; email: string }[];
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [pending, startTransition] = useTransition();

  function act(fn: () => Promise<{ error?: { message?: string } | null }>, ok: string) {
    startTransition(async () => {
      const res = await fn();
      if (res.error) return void toast.error(res.error.message ?? "Something went wrong");
      toast.success(ok);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Owners manage the menu, modifiers and settings. Staff can work the orders board and mark dishes sold out.
      </p>
      <ul className="divide-y rounded-lg border">
        {members.map((m) => (
          <li key={m.id} className="flex items-center justify-between p-3 text-sm">
            <span>
              {m.name} <span className="text-muted-foreground">{m.email}</span> · {roleLabel(m.role)}
            </span>
            {m.userId !== meId && (
              <ConfirmButton
                disabled={pending}
                title={`Remove ${m.email}?`}
                description="They lose access to this restaurant immediately."
                confirmLabel="Remove"
                onConfirm={() => act(() => authClient.organization.removeMember({ memberIdOrEmail: m.id, organizationId }), "Removed")}
              >
                Remove
              </ConfirmButton>
            )}
          </li>
        ))}
        {invites.map((i) => (
          <li key={i.id} className="flex items-center justify-between p-3 text-sm text-muted-foreground">
            <span>{i.email} · invited (staff)</span>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => act(() => authClient.organization.cancelInvitation({ invitationId: i.id }), "Invitation cancelled")}
            >
              Cancel
            </Button>
          </li>
        ))}
      </ul>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          act(async () => {
            const res = await authClient.organization.inviteMember({ email, role: "member", organizationId });
            if (!res.error) setEmail("");
            return res;
          }, "Invitation sent");
        }}
      >
        <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="staff@example.com" required />
        <Button type="submit" disabled={pending}>
          Invite staff
        </Button>
      </form>
    </div>
  );
}
