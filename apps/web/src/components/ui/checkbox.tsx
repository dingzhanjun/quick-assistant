"use client"

import * as React from "react"
import RsCheckbox from "rsuite/Checkbox"

// Adapter: a React Suite Checkbox with checked / onCheckedChange. The caption is the checkbox's accessible name.
function Checkbox({
  checked, onCheckedChange, label, disabled, id,
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  label: React.ReactNode
  disabled?: boolean
  id?: string
}) {
  return (
    <RsCheckbox checked={checked} disabled={disabled} inputProps={id ? { id } : undefined} onChange={(_value, isChecked) => onCheckedChange(isChecked)}>
      {label}
    </RsCheckbox>
  )
}

export { Checkbox }
