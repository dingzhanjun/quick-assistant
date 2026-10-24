"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/dashboard/settings", label: "General" },
  { href: "/dashboard/settings/notifications", label: "Notifications" },
  { href: "/dashboard/settings/team", label: "Team" },
  { href: "/dashboard/settings/printing", label: "Kitchen printing" },
] as const;

// Settings are split into tabs (one route each, so a tab can be linked and only loads its own data).
export function SettingsTabs() {
  const path = usePathname().replace(/\/$/, "");
  return (
    <div role="tablist" className="flex gap-1 border-b">
      {TABS.map((t) => {
        const active = path === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            role="tab"
            aria-selected={active}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
