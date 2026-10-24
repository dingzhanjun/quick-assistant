"use client";

import { useRouter } from "next/navigation";
import Button from "rsuite/Button";
import Dropdown from "rsuite/Dropdown";
import { ThemeToggle } from "@/components/theme-toggle";
import { authClient } from "@/lib/auth-client";

// Theme switch + a "User" button; its dropdown shows who is signed in (the email is not in the nav bar) and Sign out.
// `className` lets a page place it (the dashboard nav pushes the whole right-hand group with its links).
export function UserMenu({ className = "ml-auto" }: { className?: string }) {
  const router = useRouter();
  const { data } = authClient.useSession();
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      <ThemeToggle />
      <Dropdown
        size="xs"
        placement="bottomEnd"
        trigger="click"
        renderToggle={(props: object, ref: React.Ref<HTMLButtonElement>) => (
          <Button {...props} ref={ref} size="xs" appearance="subtle" aria-label="User menu">
            User ▾
          </Button>
        )}
      >
        <Dropdown.Item panel style={{ padding: "8px 16px", minWidth: 260 }}>
          <div className="text-xs text-muted-foreground">Signed in as</div>
          <div className="break-all text-sm font-medium">{data?.user.email ?? "…"}</div>
        </Dropdown.Item>
        <Dropdown.Separator />
        <Dropdown.Item
          onSelect={async () => {
            await authClient.signOut();
            router.push("/");
            router.refresh();
          }}
        >
          Sign out
        </Dropdown.Item>
      </Dropdown>
    </div>
  );
}
