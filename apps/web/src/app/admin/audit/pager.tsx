"use client";

import { useRouter } from "next/navigation";
import Pagination from "rsuite/Pagination";

// Page buttons for the audit log (and the jobs list) (React Suite Pagination). The page lives in the URL, so a page can be bookmarked.
export function AuditPager({ page, pages, query, path = "/admin/audit" }: { page: number; pages: number; query: Record<string, string>; path?: string }) {
  const router = useRouter();
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">
        Page {page} of {pages}
      </span>
      <Pagination
        prev
        next
        first
        last
        ellipsis
        boundaryLinks
        size="sm"
        maxButtons={5}
        total={pages}
        limit={1}
        activePage={page}
        onChangePage={(n) => {
          const q = new URLSearchParams({ ...query, page: String(n) });
          router.push(`${path}?${q}`);
        }}
      />
    </div>
  );
}
