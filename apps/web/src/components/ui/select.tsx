"use client"

import * as React from "react"
import SelectPicker from "rsuite/SelectPicker"

// Adapter: the app's select. Never a native <select>: this is React Suite's SelectPicker (keyboard + search + dark mode).
// Short lists are not searchable by default; options are { label, value }.
export type SelectOption<T extends string | number> = { label: string; value: T }

function Select<T extends string | number>({
  value, onChange, options, placeholder, searchable = false, cleanable = false, disabled, ariaLabel, width, id, size = "sm",
}: {
  value: T | null | undefined
  onChange: (value: T) => void
  options: SelectOption<T>[]
  placeholder?: string
  searchable?: boolean
  cleanable?: boolean
  disabled?: boolean
  ariaLabel?: string
  width?: number | string
  id?: string
  size?: "xs" | "sm" | "md" | "lg"
}) {
  return (
    <SelectPicker<T>
      id={id}
      aria-label={ariaLabel}
      data={options}
      value={value ?? null}
      onChange={(v) => v !== null && v !== undefined && onChange(v)}
      placeholder={placeholder}
      searchable={searchable}
      cleanable={cleanable}
      disabled={disabled}
      size={size}
      style={{ width: width ?? "auto", minWidth: 80 }}
      menuMaxHeight={240}
    />
  )
}

export { Select }
