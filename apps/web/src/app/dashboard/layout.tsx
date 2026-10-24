import Link from "next/link";
import { Suspense } from "react";
import { navLinkClass } from "@/components/nav-link";
import { UserMenu } from "@/components/user-menu";
import { Switcher } from "./switcher";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-5xl p-6">
      <nav className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-b pb-3 text-sm">
        <Suspense fallback={<span className="h-8 w-32" />}>
          <Switcher />
        </Suspense>
        {/* on a phone the links get their own row under the restaurant switcher and user menu */}
        <div className="order-last flex w-full gap-1 overflow-x-auto sm:order-none sm:ml-auto sm:w-auto">
          <Link href="/dashboard" className={navLinkClass}>
            Overview
          </Link>
          <Link href="/dashboard/orders" className={navLinkClass}>
            Orders
          </Link>
          <Link href="/dashboard/menu" className={navLinkClass}>
            Menu
          </Link>
          <Link href="/dashboard/categories" className={navLinkClass}>
            Categories
          </Link>
          <Link href="/dashboard/modifiers" className={navLinkClass}>
            Modifiers
          </Link>
          <Link href="/dashboard/settings" className={navLinkClass}>
            Settings
          </Link>
        </div>
        <UserMenu className="ml-auto sm:ml-0" />
      </nav>
      {children}
    </div>
  );
}
