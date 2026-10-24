"use client";

import { ThemeProvider, useTheme } from "next-themes";
import { useSyncExternalStore } from "react";
import { CustomProvider } from "rsuite";

// Light / dark mode in ONE place. next-themes toggles the `dark` class on <html> (Tailwind's `dark:` variant and our CSS
// tokens follow it) and CustomProvider switches React Suite's own theme to match. The default is the visitor's system setting.
const subscribe = () => () => {};

function Rsuite({ children }: { children: React.ReactNode }) {
  const { resolvedTheme } = useTheme();
  const mounted = useSyncExternalStore(subscribe, () => true, () => false); // false on the server and the first client render
  // before mount the server and the first client render both use "light", so hydration matches
  return <CustomProvider theme={mounted && resolvedTheme === "dark" ? "dark" : "light"}>{children}</CustomProvider>;
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <Rsuite>{children}</Rsuite>
    </ThemeProvider>
  );
}
