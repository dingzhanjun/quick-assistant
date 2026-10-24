"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

// Formats a timestamp in the viewer's locale/timezone. The server has no idea what those are,
// so it renders nothing and the browser fills it in; this avoids hydration mismatches.
export function LocalTime({ iso, kind }: { iso: string; kind: "time" | "date" | "datetime" }) {
  const text = useSyncExternalStore(
    subscribe,
    () => {
      const d = new Date(iso);
      if (kind === "datetime") return d.toLocaleString([], { dateStyle: "short", timeStyle: "medium" });
      return kind === "time" ? d.toLocaleTimeString([], { timeStyle: "short" }) : d.toLocaleDateString();
    },
    () => "",
  );
  return <span suppressHydrationWarning>{text}</span>;
}
