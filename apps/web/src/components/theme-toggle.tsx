"use client";

import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";
import Button from "rsuite/Button";
import Dropdown from "rsuite/Dropdown";

const subscribe = () => () => {};
const LABEL = { light: "Light", dark: "Dark", system: "System" } as const;

// Light / dark / follow the system. The choice is remembered by next-themes (localStorage) and applied before first paint.
export function ThemeToggle() {
  const { theme = "system", setTheme } = useTheme();
  const mounted = useSyncExternalStore(subscribe, () => true, () => false); // the saved theme is unknown on the server
  const current = (mounted && theme in LABEL ? theme : "system") as keyof typeof LABEL;
  return (
    <Dropdown
      size="xs"
      placement="bottomEnd"
      trigger="click"
      // the "Theme:" prefix only shows from tablet width up, so the phone nav stays on one row
      renderToggle={(props: object, ref: React.Ref<HTMLButtonElement>) => (
        <Button {...props} ref={ref} size="xs" appearance="subtle">
          <span className="mr-1 hidden sm:inline">Theme:</span>
          {LABEL[current]} ▾
        </Button>
      )}
    >
      {(Object.keys(LABEL) as (keyof typeof LABEL)[]).map((k) => (
        <Dropdown.Item key={k} active={current === k} onSelect={() => setTheme(k)}>
          {LABEL[k]}
        </Dropdown.Item>
      ))}
    </Dropdown>
  );
}
