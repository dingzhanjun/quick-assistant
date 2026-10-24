"use client"

import * as React from "react"
import Toggle from "rsuite/Toggle"

// Adapter: the on / off switch (React Suite Toggle) with the checked / onCheckedChange API this app uses.
// React Suite's Toggle names itself from its own `label`, so: give `label` for a visible caption, or "aria-label" for a
// switch with no caption (it becomes a visually hidden label). An external <label htmlFor> would be ignored by the Toggle.
function Switch({
  checked, defaultChecked, onCheckedChange, disabled, id, size = "default", label, "aria-label": ariaLabel,
}: {
  label?: React.ReactNode
  checked?: boolean
  defaultChecked?: boolean
  onCheckedChange?: (checked: boolean) => void
  disabled?: boolean
  id?: string
  size?: "sm" | "default"
  "aria-label"?: string
}) {
  return (
    <Toggle
      size={size === "sm" ? "sm" : "md"}
      checked={checked}
      defaultChecked={defaultChecked}
      disabled={disabled}
      onChange={(value) => onCheckedChange?.(value)}
      id={id}
      label={label ?? (ariaLabel ? <span className="sr-only">{ariaLabel}</span> : undefined)}
    />
  )
}

export { Switch }
